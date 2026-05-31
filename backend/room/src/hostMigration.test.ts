// WS-flow coverage for host migration in private rooms.
//
// A private room gates start_match / restart_room on hostPlayerId. If the host
// leaves and the role is never reassigned, the remaining players are stranded -
// nobody can start or replay. detach keeps the role through the reconnect grace
// window (a transient drop resumes as host); finalizeDisconnect, once the host
// is truly gone, hands the role to a remaining human and broadcasts host_changed
// so the promoted client learns it (it never held the host token).
//
// Open rooms have no host (no expectedHostToken) and must never grow one.
//
// Same private-member reach-in convention as matchStartSnapshot.test.ts.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { PlayerState } from '@cm/shared';
import { Room, type RoomEnv } from './room.ts';
import { RECONNECT_GRACE_MS } from './sessionManager.ts';

function makeMockStorage() {
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
  const room = new Room(state as unknown as DurableObjectState, {} as RoomEnv);
  (room as unknown as { walls: readonly unknown[] }).walls = [];
  return room;
}

class RecordingSocket {
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  decoded(): { t: string; kind?: { kind?: string; hostId?: string } }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  hostChangedIds(): string[] {
    return this.decoded()
      .filter((m) => m.t === 'event' && m.kind?.kind === 'host_changed')
      .map((m) => m.kind!.hostId!);
  }
}

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

function set(room: Room, key: string, value: unknown): void {
  (room as unknown as Record<string, unknown>)[key] = value;
}
function get<T>(room: Room, key: string): T {
  return (room as unknown as Record<string, T>)[key];
}
function detach(room: Room, ws: RecordingSocket): void {
  (room as unknown as { detach: (ws: unknown) => void }).detach(ws);
}

const HOST = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('host migration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('promotes a remaining human when the host leaves the lobby', () => {
    const room = makeRoom();
    set(room, 'phase', 'filling');
    set(room, 'expectedHostToken', 'tok');
    const host = connectHuman(room, HOST, 'mime');
    const other = connectHuman(room, OTHER, 'clown');
    set(room, 'hostPlayerId', HOST);

    // In `filling`, detach finalizes immediately (no grace window).
    detach(room, host);

    expect(get<string | null>(room, 'hostPlayerId')).toBe(OTHER);
    expect(other.hostChangedIds()).toEqual([OTHER]);
    expect(get<Map<string, unknown>>(room, 'players').has(HOST)).toBe(false);
  });

  it('keeps the host role through a transient drop, then promotes after grace', () => {
    const room = makeRoom();
    set(room, 'phase', 'free_roam');
    set(room, 'expectedHostToken', 'tok');
    const host = connectHuman(room, HOST, 'mime');
    const other = connectHuman(room, OTHER, 'clown');
    set(room, 'hostPlayerId', HOST);

    detach(room, host);

    // Mid-match drop schedules a finalize but holds the role open so a quick
    // resume comes back as host. Nothing is promoted yet.
    expect(get<string | null>(room, 'hostPlayerId')).toBe(HOST);
    expect(other.hostChangedIds()).toEqual([]);

    // Grace expires with no resume: the role transfers to the other human.
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);
    expect(get<string | null>(room, 'hostPlayerId')).toBe(OTHER);
    expect(other.hostChangedIds()).toEqual([OTHER]);
  });

  it('does not grow a host in an open room with no host token', () => {
    const room = makeRoom();
    set(room, 'phase', 'filling');
    // expectedHostToken stays null (open / strangers room) and hostPlayerId null.
    const leaver = connectHuman(room, HOST, 'mime');
    const other = connectHuman(room, OTHER, 'clown');

    detach(room, leaver);

    expect(get<string | null>(room, 'hostPlayerId')).toBeNull();
    expect(other.hostChangedIds()).toEqual([]);
  });
});
