import { describe, expect, it } from 'vitest';
import {
  MatchmakerDO,
  OPEN_ROOM_FRESH_MS,
  OPEN_ROOM_SOFT_CAPACITY,
  pickRoom,
  pruneStale,
  type OpenRoomEntry,
} from './matchmakerDO.ts';

function entry(partial: Partial<OpenRoomEntry> & { roomId: string }): OpenRoomEntry {
  return {
    topology: 'plane',
    humans: 0,
    bots: 0,
    lastSeenAt: 1_000_000,
    createdAt: 1_000_000,
    ...partial,
  };
}

describe('pickRoom', () => {
  const now = 2_000_000;

  it('returns null when no rooms exist', () => {
    expect(pickRoom(new Map(), now)).toBeNull();
  });

  it('skips rooms at or above soft capacity', () => {
    const rooms = new Map<string, OpenRoomEntry>([
      ['a', entry({ roomId: 'a', humans: OPEN_ROOM_SOFT_CAPACITY, bots: 0, lastSeenAt: now })],
    ]);
    expect(pickRoom(rooms, now)).toBeNull();
  });

  it('skips stale rooms past the fresh window', () => {
    const rooms = new Map<string, OpenRoomEntry>([
      ['a', entry({ roomId: 'a', humans: 1, lastSeenAt: now - OPEN_ROOM_FRESH_MS - 1 })],
    ]);
    expect(pickRoom(rooms, now)).toBeNull();
  });

  it('prefers the highest humans count', () => {
    const rooms = new Map<string, OpenRoomEntry>([
      ['a', entry({ roomId: 'a', humans: 1, bots: 3, lastSeenAt: now })],
      ['b', entry({ roomId: 'b', humans: 3, bots: 0, lastSeenAt: now })],
      ['c', entry({ roomId: 'c', humans: 2, bots: 0, lastSeenAt: now })],
    ]);
    expect(pickRoom(rooms, now)?.roomId).toBe('b');
  });

  it('tiebreaks on highest humans + bots when humans tie', () => {
    const rooms = new Map<string, OpenRoomEntry>([
      ['a', entry({ roomId: 'a', humans: 2, bots: 1, lastSeenAt: now })],
      ['b', entry({ roomId: 'b', humans: 2, bots: 3, lastSeenAt: now })],
    ]);
    expect(pickRoom(rooms, now)?.roomId).toBe('b');
  });
});

describe('pruneStale', () => {
  it('drops entries past the prune cutoff', () => {
    const now = 10 * 60 * 1000 + 5_000;
    const rooms = new Map<string, OpenRoomEntry>([
      ['fresh', entry({ roomId: 'fresh', lastSeenAt: now - 1_000 })],
      ['stale', entry({ roomId: 'stale', lastSeenAt: now - 10 * 60 * 1000 - 1 })],
    ]);
    pruneStale(rooms, now);
    expect([...rooms.keys()]).toEqual(['fresh']);
  });
});

// In-memory stand-in for DurableObjectStorage. Just enough to satisfy the
// MatchmakerDO's put/get on STORAGE_KEY.
class FakeStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}

function makeDO(): MatchmakerDO {
  const state = {
    storage: new FakeStorage(),
  } as unknown as DurableObjectState;
  return new MatchmakerDO(state);
}

async function call(
  doInstance: MatchmakerDO,
  path: string,
  body?: unknown,
): Promise<{ res: Response; json: unknown }> {
  const res = await doInstance.fetch(
    new Request(`https://x.test${path}`, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : '{}',
      headers: { 'content-type': 'application/json' },
    }),
  );
  const parsed = await res.clone().json();
  return { res, json: parsed };
}

describe('MatchmakerDO.fetch', () => {
  it('openJoin creates a fresh room when none exist', async () => {
    const doInstance = makeDO();
    const { res, json } = await call(doInstance, '/openJoin');
    expect(res.status).toBe(200);
    const body = json as { roomId: string; topology: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.roomId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('openJoin reuses the same room on a second call', async () => {
    const doInstance = makeDO();
    const { json: first } = await call(doInstance, '/openJoin');
    const { json: second } = await call(doInstance, '/openJoin');
    const a = first as { roomId: string; created: boolean };
    const b = second as { roomId: string; created: boolean };
    expect(b.roomId).toBe(a.roomId);
    expect(b.created).toBe(false);
  });

  it('roomState updates counts and roomDetach removes empty rooms', async () => {
    const doInstance = makeDO();
    const { json: first } = await call(doInstance, '/openJoin');
    const roomId = (first as { roomId: string }).roomId;

    await call(doInstance, '/roomState', { roomId, humans: 2, bots: 4 });
    // A second openJoin should still pick this same room (only one exists,
    // and humans+bots < capacity).
    const { json: second } = await call(doInstance, '/openJoin');
    expect((second as { roomId: string }).roomId).toBe(roomId);

    await call(doInstance, '/roomState', { roomId, humans: 0, bots: 0 });
    await call(doInstance, '/roomDetach', { roomId });
    // After detach the next openJoin must mint a new room.
    const { json: third } = await call(doInstance, '/openJoin');
    expect((third as { roomId: string; created: boolean }).created).toBe(true);
    expect((third as { roomId: string }).roomId).not.toBe(roomId);
  });

  it('roomDetach removes an occupied room from the open pool', async () => {
    // Regression for the 4003 'match_in_progress' loop: rooms call detach
    // when phase moves past 'filling', but at that moment they typically
    // still have humans+bots > 0. Previously detach only deleted empty
    // entries, so an occupied non-filling room stayed in the pool and the
    // next /openJoin handed it back, the client connected, and the room
    // immediately rejected with close-4003.
    const doInstance = makeDO();
    const { json: first } = await call(doInstance, '/openJoin');
    const roomId = (first as { roomId: string }).roomId;
    await call(doInstance, '/roomState', { roomId, humans: 2, bots: 4 });

    await call(doInstance, '/roomDetach', { roomId });

    // The next openJoin must mint a fresh room - the detached one is
    // no longer eligible regardless of its occupant count.
    const { json: second } = await call(doInstance, '/openJoin');
    expect((second as { created: boolean }).created).toBe(true);
    expect((second as { roomId: string }).roomId).not.toBe(roomId);
  });

  it('roomState does not resurrect a detached entry', async () => {
    // Regression for the reproducible "start game -> quit -> Find Match ->
    // 4003" loop reported 2026-05-29. The room fires two fire-and-forget
    // POSTs at match start: /roomState from fillTeams, then /roomDetach
    // from startMatch. If they arrived at the matchmaker in reverse order
    // and roomState had a defensive-create branch, the entry came back
    // with a fresh lastSeenAt and the next /openJoin returned it. The
    // joining client then got close-4003 from a room already in
    // free_roam. Update-only: a missing entry stays missing.
    const doInstance = makeDO();
    const { json: first } = await call(doInstance, '/openJoin');
    const roomId = (first as { roomId: string }).roomId;
    await call(doInstance, '/roomDetach', { roomId });

    // A late roomState POST must NOT resurrect the entry.
    await call(doInstance, '/roomState', { roomId, humans: 1, bots: 6 });

    const { json: second } = await call(doInstance, '/openJoin');
    expect((second as { created: boolean }).created).toBe(true);
    expect((second as { roomId: string }).roomId).not.toBe(roomId);
  });

  it('roomState rejects malformed bodies', async () => {
    const doInstance = makeDO();
    const { res } = await call(doInstance, '/roomState', { roomId: 'x' });
    expect(res.status).toBe(400);
  });
});
