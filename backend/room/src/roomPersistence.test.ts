// End-to-end persistence smoke: simulate a wrangler-deploy DO bounce by
// constructing one Room, mutating it, then constructing a second Room
// against the same storage backend and asserting the relevant fields
// carried across. The mock storage uses the same shape as
// simulate.test.ts so the two test files share the construction pattern.

import { describe, expect, it } from 'vitest';
import type { PlayerState } from '@cm/shared';
import { Room, type RoomEnv } from './room.ts';

interface MockStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

function makeSharedStorage(): MockStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      // Deep clone so subsequent in-place mutations on the live room
      // don't leak into the persisted blob - DO storage really
      // serializes through structured clone, so tests should match.
      map.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

function makeRoomAgainst(storage: MockStorage): { room: Room; done: Promise<void> } {
  // Capture the blockConcurrencyWhile promise so callers can await
  // restoration before reading the room.
  let restorePromise: Promise<void> = Promise.resolve();
  const state = {
    id: { toString: () => 'test-room-persist' },
    acceptWebSocket: () => {
      // Unused on the persistence path.
    },
    storage,
    blockConcurrencyWhile: <T,>(fn: () => Promise<T>): Promise<T> => {
      const p = fn();
      restorePromise = p.then(() => undefined);
      return p;
    },
  };
  const env: RoomEnv = {};
  const room = new Room(state as unknown as DurableObjectState, env);
  return { room, done: restorePromise };
}

function placeHuman(
  room: Room,
  id: string,
  team: 'mime' | 'clown',
  x: number,
  z: number,
): PlayerState {
  const player: PlayerState = {
    id,
    name: id,
    team,
    bot: false,
    position: { x, y: 0.5, z },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  };
  (room as unknown as { players: Map<string, PlayerState> }).players.set(id, player);
  return player;
}

interface SessionLike {
  exportSessions(): Array<[string, string]>;
  restore(id: string, token: string): void;
}

function primeSession(room: Room, playerId: string, token: string): void {
  // Reach into the SessionManager to install a known token. Real code
  // mints via mint() during onJoin; this lets the test assert that the
  // exact token survives a restart.
  const sessions = (room as unknown as { sessions: SessionLike }).sessions;
  sessions.restore(playerId, token);
}

function setRoomScalar<K extends string>(room: Room, field: K, value: unknown): void {
  (room as unknown as Record<string, unknown>)[field] = value;
}

function persistNow(room: Room): void {
  (room as unknown as { persist(): void }).persist();
}

describe('Room persistence across DO restart', () => {
  it('restores phase, seed, topology, players, and session tokens', async () => {
    const storage = makeSharedStorage();

    // First incarnation: seed the room and write to storage.
    const first = makeRoomAgainst(storage);
    await first.done;
    setRoomScalar(first.room, 'phase', 'free_roam');
    setRoomScalar(first.room, 'seed', 12345);
    setRoomScalar(first.room, 'topology', 'torus');
    setRoomScalar(first.room, 'turnEndsAt', 1_000_000);
    setRoomScalar(first.room, 'roundNumber', 2);
    setRoomScalar(first.room, 'firstTeam', 'clown');
    placeHuman(first.room, 'h1', 'mime', 3.5, -2.0);
    placeHuman(first.room, 'h2', 'clown', -3.5, 2.0);
    primeSession(first.room, 'h1', 'tok-h1');
    primeSession(first.room, 'h2', 'tok-h2');
    persistNow(first.room);

    // Second incarnation: same storage, fresh in-memory state.
    const second = makeRoomAgainst(storage);
    await second.done;
    const players = (second.room as unknown as { players: Map<string, PlayerState> }).players;
    const sessions = (second.room as unknown as { sessions: SessionLike }).sessions;

    expect((second.room as unknown as { phase: string }).phase).toBe('free_roam');
    expect((second.room as unknown as { seed: number }).seed).toBe(12345);
    expect((second.room as unknown as { topology: string }).topology).toBe('torus');
    expect((second.room as unknown as { turnEndsAt: number }).turnEndsAt).toBe(1_000_000);
    expect((second.room as unknown as { roundNumber: number }).roundNumber).toBe(2);
    expect((second.room as unknown as { firstTeam: string }).firstTeam).toBe('clown');
    expect(players.size).toBe(2);
    expect(players.get('h1')?.position).toEqual({ x: 3.5, y: 0.5, z: -2.0 });
    expect(players.get('h2')?.team).toBe('clown');
    const exported = new Map(sessions.exportSessions());
    expect(exported.get('h1')).toBe('tok-h1');
    expect(exported.get('h2')).toBe('tok-h2');
  });

  it('returns null restore on a fresh storage (cold-boot DO)', async () => {
    const storage = makeSharedStorage();
    const { room, done } = makeRoomAgainst(storage);
    await done;
    // Untouched DO defaults to filling, empty players, random seed.
    expect((room as unknown as { phase: string }).phase).toBe('filling');
    expect((room as unknown as { players: Map<string, PlayerState> }).players.size).toBe(0);
  });

  it('regenerates walls deterministically from the persisted seed on restart', async () => {
    const storage = makeSharedStorage();
    const first = makeRoomAgainst(storage);
    await first.done;
    setRoomScalar(first.room, 'seed', 7777);
    setRoomScalar(first.room, 'topology', 'plane');
    placeHuman(first.room, 'h1', 'mime', 0, 0);
    persistNow(first.room);

    // Two fresh DOs against the same storage should both regenerate
    // identical wall counts for the persisted (seed, topology). Walls
    // are deliberately NOT persisted because they are deterministic
    // from (seed, topology); restoring them would just inflate the
    // storage blob.
    const second = makeRoomAgainst(storage);
    await second.done;
    const third = makeRoomAgainst(storage);
    await third.done;
    const secondWalls = (second.room as unknown as { walls: readonly unknown[] }).walls.length;
    const thirdWalls = (third.room as unknown as { walls: readonly unknown[] }).walls.length;
    expect(secondWalls).toBe(thirdWalls);
    expect(secondWalls).toBeGreaterThan(0);
  });
});
