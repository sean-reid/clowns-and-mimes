// WS-flow coverage for the match-start snapshot resend.
//
// startMatch() spawns the floor items and then re-sends a full snapshot to
// every live connection. That resend is the only path that carries the static
// item layout to clients which joined during `filling` (their join snapshot
// had no items yet). Unlike a plain broadcast it must stamp each envelope with
// the recipient's own youAre + sessionToken, so a regression here silently
// hands clients the wrong identity or strands them without power-ups.
//
// We stand up a Room with a mock DurableObjectState and reach into private
// members via `(room as any).x`, matching the simulate harness convention.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { PlayerState, RoomSnapshot } from '@cm/shared';
import { Room, type RoomEnv } from './room.ts';

interface MockStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

function makeMockStorage(): MockStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

function makeRoom(): Room {
  const state = {
    id: { toString: () => 'test-room-0001' },
    acceptWebSocket: () => {},
    storage: makeMockStorage(),
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    getWebSockets: () => [],
  };
  const env: RoomEnv = {};
  const room = new Room(state as unknown as DurableObjectState, env);
  // Walls are seeded non-deterministically and can swallow the spawn point;
  // clear them so balanceHumansForMatchStart's respawn lands cleanly.
  (room as unknown as { walls: readonly unknown[] }).walls = [];
  return room;
}

// A WebSocket stand-in that records the JSON frames the Room sends it.
class RecordingSocket {
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  decoded(): { t: string; [k: string]: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  snapshots(): { snapshot: RoomSnapshot; youAre: string; sessionToken: string }[] {
    return this.decoded().filter((m) => m.t === 'snapshot') as never;
  }
}

// Register a connected human: seed the player, wire the connection, mint a
// session token (as onJoin would), and clear any frames sent so far.
function connectHuman(room: Room, id: string, team: 'mime' | 'clown'): RecordingSocket {
  const ws = new RecordingSocket();
  const player: PlayerState = {
    id,
    name: id,
    team,
    bot: false,
    position: { x: 0, y: 0.5, z: 0 },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  };
  (room as unknown as { players: Map<string, PlayerState> }).players.set(id, player);
  (room as unknown as { connections: Map<unknown, unknown> }).connections.set(ws, {
    ws,
    playerId: id,
  });
  (room as unknown as { sessions: { mint: (id: string) => string } }).sessions.mint(id);
  ws.sent.length = 0;
  return ws;
}

function setPhase(room: Room, phase: string): void {
  (room as unknown as { phase: string }).phase = phase;
}

function startMatch(room: Room): void {
  (room as unknown as { startMatch: () => void }).startMatch();
  // startMatch arms the tick interval; stop it so the fake timer queue stays
  // empty between tests.
  clearInterval((room as unknown as { tickHandle: ReturnType<typeof setInterval> }).tickHandle);
}

describe('match-start snapshot resend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resends a snapshot to every connection carrying the spawned items', () => {
    const room = makeRoom();
    setPhase(room, 'filling');
    const a = connectHuman(room, 'aaaaaaaa-0000-0000-0000-000000000001', 'mime');
    const b = connectHuman(room, 'bbbbbbbb-0000-0000-0000-000000000002', 'clown');

    startMatch(room);

    for (const ws of [a, b]) {
      const snaps = ws.snapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]!.snapshot.phase).toBe('free_roam');
      // The whole point of the resend: floor items reach clients that joined
      // before items.spawn() ran.
      expect(snaps[0]!.snapshot.items?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('stamps each envelope with the recipient own youAre + sessionToken', () => {
    const room = makeRoom();
    setPhase(room, 'filling');
    const idA = 'aaaaaaaa-0000-0000-0000-000000000001';
    const idB = 'bbbbbbbb-0000-0000-0000-000000000002';
    const a = connectHuman(room, idA, 'mime');
    const b = connectHuman(room, idB, 'clown');
    const sessions = (
      room as unknown as {
        sessions: { tokenFor: (id: string) => string };
      }
    ).sessions;

    startMatch(room);

    const snapA = a.snapshots()[0]!;
    const snapB = b.snapshots()[0]!;
    expect(snapA.youAre).toBe(idA);
    expect(snapB.youAre).toBe(idB);
    expect(snapA.sessionToken).toBe(sessions.tokenFor(idA));
    expect(snapB.sessionToken).toBe(sessions.tokenFor(idB));
    // Tokens are minted per player, so they must not collide.
    expect(snapA.sessionToken).not.toBe(snapB.sessionToken);
    expect(snapA.sessionToken).not.toBe('');
  });

  it('broadcasts the free_roam phase event alongside the resend', () => {
    const room = makeRoom();
    setPhase(room, 'filling');
    const a = connectHuman(room, 'aaaaaaaa-0000-0000-0000-000000000001', 'mime');

    startMatch(room);

    const phaseEvents = a
      .decoded()
      .filter((m) => m.t === 'event' && (m.kind as { kind?: string })?.kind === 'phase');
    expect(phaseEvents).toHaveLength(1);
    expect((phaseEvents[0]!.kind as { phase: string }).phase).toBe('free_roam');
  });
});
