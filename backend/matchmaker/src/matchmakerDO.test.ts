import { PARTY_CAP } from '@cm/shared';
import { describe, expect, it } from 'vitest';
import {
  MatchmakerDO,
  OPEN_ROOM_FRESH_MS,
  OPEN_ROOM_SOFT_CAPACITY,
  PARTY_PRUNE_MS,
  type PartyEntry,
  pickRoom,
  pruneStale,
  pruneStaleParties,
  slotsUsed,
  type OpenRoomEntry,
} from './matchmakerDO.ts';

function entry(partial: Partial<OpenRoomEntry> & { roomId: string }): OpenRoomEntry {
  return {
    topology: 'plane',
    humans: 0,
    bots: 0,
    reserved: 0,
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

  it('skips a room that cannot seat the whole party (needed)', () => {
    const rooms = new Map<string, OpenRoomEntry>([
      ['a', entry({ roomId: 'a', humans: OPEN_ROOM_SOFT_CAPACITY - 3, bots: 0, lastSeenAt: now })],
    ]);
    expect(pickRoom(rooms, now, 4)).toBeNull(); // 3 free < 4 needed
    expect(pickRoom(rooms, now, 3)?.roomId).toBe('a'); // exactly fits
  });

  it('counts reserved seats against capacity', () => {
    const e = entry({ roomId: 'a', humans: 1, bots: 0, reserved: 8, lastSeenAt: now });
    expect(slotsUsed(e)).toBe(9);
    const rooms = new Map<string, OpenRoomEntry>([['a', e]]);
    expect(pickRoom(rooms, now, 4)).toBeNull(); // 9 + 4 > capacity
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

  it('returns the same party team to every member open-join', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'A' });
    const { partyId, code, team } = created as { partyId: string; code: string; team: string };
    await call(doInstance, '/partyJoin', { code, name: 'B' });
    const { json: a } = await call(doInstance, '/openJoin', { partyId });
    const { json: b } = await call(doInstance, '/openJoin', { partyId });
    expect((a as { team?: string }).team).toBe(team);
    expect((b as { team?: string }).team).toBe(team);
  });

  it('reserves the rest of a party on the first member open-join', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'A' });
    const { partyId, code } = created as { partyId: string; code: string };
    await call(doInstance, '/partyJoin', { code, name: 'B' });
    await call(doInstance, '/partyJoin', { code, name: 'C' }); // party of 3
    const { json } = await call(doInstance, '/openJoin', { partyId });
    const roomId = (json as { roomId: string }).roomId;
    const rooms = (doInstance as unknown as { openRooms: Map<string, OpenRoomEntry> }).openRooms;
    const room = rooms.get(roomId)!;
    // The joining member takes a real slot; the other two are held.
    expect(room.humans).toBe(1);
    expect(room.reserved).toBe(2);
  });

  it('a later party member claims a reserved seat without creating a room', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'A' });
    const { partyId, code } = created as { partyId: string; code: string };
    await call(doInstance, '/partyJoin', { code, name: 'B' }); // party of 2
    const { json: first } = await call(doInstance, '/openJoin', { partyId });
    const roomId = (first as { roomId: string }).roomId;
    const { json: second } = await call(doInstance, '/openJoin', { partyId });
    const rooms = (doInstance as unknown as { openRooms: Map<string, OpenRoomEntry> }).openRooms;
    expect((second as { roomId: string }).roomId).toBe(roomId); // same room
    expect(rooms.size).toBe(1); // no extra room spun up
    expect(rooms.get(roomId)!.reserved).toBe(0); // both seats now claimed
  });

  it('routes a party away from a room that cannot fit all of them', async () => {
    const doInstance = makeDO();
    const rooms = (doInstance as unknown as { openRooms: Map<string, OpenRoomEntry> }).openRooms;
    // Seed a near-full room: only 2 free slots, but the party needs 3.
    const now = Date.now();
    rooms.set('full', {
      roomId: 'full',
      topology: 'plane',
      humans: OPEN_ROOM_SOFT_CAPACITY - 2,
      bots: 0,
      reserved: 0,
      lastSeenAt: now,
      createdAt: now,
    });
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'A' });
    const { partyId, code } = created as { partyId: string; code: string };
    await call(doInstance, '/partyJoin', { code, name: 'B' });
    await call(doInstance, '/partyJoin', { code, name: 'C' }); // party of 3
    const { json } = await call(doInstance, '/openJoin', { partyId });
    // Can't fit 3 in the 2-slot room, so a fresh room is created instead.
    expect((json as { roomId: string; created: boolean }).roomId).not.toBe('full');
    expect((json as { created: boolean }).created).toBe(true);
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

describe('pruneStaleParties', () => {
  it('drops parties past the prune cutoff', () => {
    const now = PARTY_PRUNE_MS + 5_000;
    const base: Omit<PartyEntry, 'id' | 'code' | 'lastSeenAt'> = {
      team: 'mime',
      members: [],
      roomId: null,
      createdAt: 0,
    };
    const parties = new Map<string, PartyEntry>([
      ['fresh', { ...base, id: 'fresh', code: 'AAAAAA', lastSeenAt: now - 1_000 }],
      ['stale', { ...base, id: 'stale', code: 'BBBBBB', lastSeenAt: now - PARTY_PRUNE_MS - 1 }],
    ]);
    pruneStaleParties(parties, now);
    expect([...parties.keys()]).toEqual(['fresh']);
  });
});

describe('MatchmakerDO parties', () => {
  it('partyCreate returns a code, ids, a team, and the founding member', async () => {
    const doInstance = makeDO();
    const { res, json } = await call(doInstance, '/partyCreate', { name: 'Ada' });
    expect(res.status).toBe(200);
    const body = json as {
      partyId: string;
      code: string;
      team: string;
      memberId: string;
      members: { memberId: string; name: string }[];
    };
    expect(body.partyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(['mime', 'clown']).toContain(body.team);
    expect(body.members).toEqual([{ memberId: body.memberId, name: 'Ada' }]);
  });

  it('partyJoin adds a member and keeps the same id/code/team', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'Ada' });
    const party = created as { partyId: string; code: string; team: string };
    const { res, json } = await call(doInstance, '/partyJoin', {
      code: party.code,
      name: 'Bob',
    });
    expect(res.status).toBe(200);
    const joined = json as {
      partyId: string;
      code: string;
      team: string;
      members: { name: string }[];
    };
    expect(joined.partyId).toBe(party.partyId);
    expect(joined.team).toBe(party.team);
    expect(joined.members.map((m) => m.name)).toEqual(['Ada', 'Bob']);
  });

  it('partyState exposes roomId so waiting members can auto-follow the match', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'Ada' });
    const partyId = (created as { partyId: string }).partyId;
    const stateOf = async (): Promise<{ roomId: string | null }> => {
      const res = await doInstance.fetch(
        new Request(`https://x.test/partyState?id=${partyId}`, { method: 'GET' }),
      );
      return (await res.json()) as { roomId: string | null };
    };
    // Before anyone finds a match, there is no shared room yet.
    expect((await stateOf()).roomId).toBeNull();
    // One member finds a match (open-join with the party id), stamping the room.
    const { json: joined } = await call(doInstance, '/openJoin', { partyId });
    const roomId = (joined as { roomId: string }).roomId;
    // The poll now reports it, which is what makes the rest of the party follow.
    expect((await stateOf()).roomId).toBe(roomId);

    // When that room detaches (its match started), the party's pointer clears so
    // a return-and-requeue routes them to a fresh room, not the dead one.
    await call(doInstance, '/roomDetach', { roomId });
    expect((await stateOf()).roomId).toBeNull();
  });

  it('partyJoin lowercases-insensitively matches the code', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'Ada' });
    const code = (created as { code: string }).code;
    const { res } = await call(doInstance, '/partyJoin', {
      code: code.toLowerCase(),
      name: 'Bob',
    });
    expect(res.status).toBe(200);
  });

  it('partyJoin 404s an unknown code', async () => {
    const doInstance = makeDO();
    const { res } = await call(doInstance, '/partyJoin', { code: 'ZZZZZZ', name: 'Bob' });
    expect(res.status).toBe(404);
  });

  it('partyJoin 409s a full party', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'p0' });
    const code = (created as { code: string }).code;
    for (let i = 1; i < PARTY_CAP; i += 1) {
      const { res } = await call(doInstance, '/partyJoin', { code, name: `p${i}` });
      expect(res.status).toBe(200);
    }
    const { res } = await call(doInstance, '/partyJoin', { code, name: 'overflow' });
    expect(res.status).toBe(409);
  });

  it('partyLeave removes a member and deletes the party when empty', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'Ada' });
    const party = created as { partyId: string; code: string; memberId: string };
    await call(doInstance, '/partyLeave', {
      partyId: party.partyId,
      memberId: party.memberId,
    });
    // The party is now empty and gone, so joining by its code 404s.
    const { res } = await call(doInstance, '/partyJoin', { code: party.code, name: 'Bob' });
    expect(res.status).toBe(404);
  });

  it('routes both party members to the same room and team via open-join', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'Ada' });
    const party = created as { partyId: string; code: string; team: string };
    await call(doInstance, '/partyJoin', { code: party.code, name: 'Bob' });

    const { json: first } = await call(doInstance, '/openJoin', { partyId: party.partyId });
    const a = first as { roomId: string; team: string; created: boolean };
    expect(a.team).toBe(party.team);

    const { json: second } = await call(doInstance, '/openJoin', { partyId: party.partyId });
    const b = second as { roomId: string; team: string; created: boolean };
    expect(b.roomId).toBe(a.roomId);
    expect(b.created).toBe(false);
    expect(b.team).toBe(party.team);
  });

  it('open-join without a partyId carries no team', async () => {
    const doInstance = makeDO();
    const { json } = await call(doInstance, '/openJoin');
    expect((json as { team?: string }).team).toBeUndefined();
  });

  it('partyState returns the live roster as members join', async () => {
    const doInstance = makeDO();
    const { json: created } = await call(doInstance, '/partyCreate', { name: 'Ada' });
    const party = created as { partyId: string; code: string; team: string };
    await call(doInstance, '/partyJoin', { code: party.code, name: 'Bob' });

    const res = await doInstance.fetch(
      new Request(`https://x.test/partyState?id=${party.partyId}`, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      partyId: string;
      code: string;
      team: string;
      members: { name: string }[];
    };
    expect(view.partyId).toBe(party.partyId);
    expect(view.code).toBe(party.code);
    expect(view.team).toBe(party.team);
    expect(view.members.map((m) => m.name)).toEqual(['Ada', 'Bob']);
  });

  it('partyState 404s an unknown party id', async () => {
    const doInstance = makeDO();
    const res = await doInstance.fetch(
      new Request('https://x.test/partyState?id=missing', { method: 'GET' }),
    );
    expect(res.status).toBe(404);
  });
});
