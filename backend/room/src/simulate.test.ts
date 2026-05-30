// Phase A1 of the file-split plan: deterministic simulate harness.
//
// Stands up a Room with a mock DurableObjectState, manually seeds the
// player/wall/topology state, drives a fixed input stream through N
// ticks of simulate(), and asserts the final snapshot. The simulate
// loop itself is what we want to verify before extracting GameSimulation
// and BotManager - this is the regression net those refactors will
// land against.
//
// We reach into private members via `(room as any).x = ...` because
// the goal is to exercise the existing structure without changing it.
// When GameSimulation is extracted, these tests get rewritten to call
// the new module's public API.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { PlayerInput, PlayerState } from '@cm/shared';
import { Room, type RoomEnv } from './room.ts';

interface MockStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface MockState {
  id: { toString: () => string };
  acceptWebSocket: (ws: WebSocket) => void;
  storage: MockStorage;
  blockConcurrencyWhile: <T>(fn: () => Promise<T>) => Promise<T>;
  getWebSockets: () => WebSocket[];
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

function makeMockState(roomId = 'test-room-0001'): MockState {
  return {
    id: { toString: () => roomId },
    acceptWebSocket: () => {
      // Not used by simulate path; only fetch() calls it.
    },
    storage: makeMockStorage(),
    // The real DurableObjectState.blockConcurrencyWhile defers WS dispatch
    // until the promise resolves. Tests don't dispatch through WS so the
    // fire-and-forget behavior is enough; the constructor's restore await
    // still runs to completion before the test reads any state.
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    // No hibernated WSes in unit tests; the simulate path doesn't go
    // through the WS upgrade handler.
    getWebSockets: () => [],
  };
}

function makeRoom(): Room {
  const state = makeMockState();
  const env: RoomEnv = {};
  // The Room constructor signature is (state, env). The mock satisfies
  // the bits simulate cares about; the rest is unreached during
  // simulate-only tests.
  const room = new Room(state as unknown as DurableObjectState, env);
  // The constructor seeds walls from `Math.floor(Math.random() * 2**31)`
  // and a generated labyrinth, which is non-deterministic across test
  // runs AND may put the spawn-at-origin player inside a wall cell.
  // Clear walls for the simulate fixture; specific wall behavior is
  // covered by the movement determinism fixture in @cm/shared.
  (room as unknown as { walls: readonly unknown[] }).walls = [];
  return room;
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

function queueInput(room: Room, playerId: string, input: PlayerInput): void {
  const queues = (room as unknown as { inputQueues: Map<string, PlayerInput[]> }).inputQueues;
  let q = queues.get(playerId);
  if (!q) {
    q = [];
    queues.set(playerId, q);
  }
  q.push(input);
}

function callSimulate(room: Room): void {
  // After Phase B2, simulate() lives on GameSimulation. The test reaches
  // through the Room's `sim` field to drive it directly so we exercise
  // the same code path tick() runs without going through setInterval.
  (room as unknown as { sim: { simulate: () => void } }).sim.simulate();
}

function setPhase(room: Room, phase: string): void {
  (room as unknown as { phase: string }).phase = phase;
}

describe('Room.simulate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks a human +x at WALK_SPEED over many ticks', () => {
    const room = makeRoom();
    setPhase(room, 'free_roam');
    placeHuman(room, 'h1', 'mime', 0, 0);
    // 60 input ticks at dt=1/60, move +x. Single-player so no
    // bouncebacks distort the path.
    for (let seq = 1; seq <= 60; seq += 1) {
      queueInput(room, 'h1', {
        seq,
        dt: 1 / 60,
        move: { x: 1, z: 0 },
        lookYaw: 0,
        sprint: false,
        nowMs: Date.now(),
      });
      callSimulate(room);
      vi.advanceTimersByTime(1000 / 60);
    }
    const players = (room as unknown as { players: Map<string, PlayerState> }).players;
    const h1 = players.get('h1')!;
    // 60 ticks * 3.2 m/s * (1/60) s = 3.2 m.
    expect(h1.position.x).toBeCloseTo(3.2, 5);
    expect(h1.position.z).toBeCloseTo(0, 5);
    expect(h1.frozen).toBe(false);
  });

  it('depletes sprint energy over sustained sprint, then latches off', () => {
    const room = makeRoom();
    setPhase(room, 'free_roam');
    const h1 = placeHuman(room, 'h1', 'mime', 0, 0);
    h1.sprintEnergy = 100;
    // SPRINT_DRAIN_PER_S = 25; 100 / 25 = 4 s = 240 ticks at 60Hz.
    for (let seq = 1; seq <= 240; seq += 1) {
      queueInput(room, 'h1', {
        seq,
        dt: 1 / 60,
        move: { x: 0, z: 1 },
        lookYaw: 0,
        sprint: true,
        nowMs: Date.now(),
      });
      callSimulate(room);
      vi.advanceTimersByTime(1000 / 60);
    }
    const after = (room as unknown as { players: Map<string, PlayerState> }).players.get('h1')!;
    expect(after.sprintEnergy).toBe(0);
    expect(after.sprinting).toBe(false);
    expect(after.position.z).toBeGreaterThan(20); // sprint covered ~22 m before depletion
  });

  it('records position history for lag compensation', () => {
    const room = makeRoom();
    setPhase(room, 'free_roam');
    placeHuman(room, 'h1', 'mime', 0, 0);
    for (let seq = 1; seq <= 10; seq += 1) {
      queueInput(room, 'h1', {
        seq,
        dt: 1 / 60,
        move: { x: 1, z: 0 },
        lookYaw: 0,
        sprint: false,
        nowMs: Date.now(),
      });
      callSimulate(room);
      vi.advanceTimersByTime(1000 / 60);
    }
    const history = (
      room as unknown as {
        positionHistory: Map<string, Array<{ t: number; x: number; z: number }>>;
      }
    ).positionHistory;
    const h1Trail = history.get('h1');
    expect(h1Trail).toBeDefined();
    expect(h1Trail!.length).toBeGreaterThan(0);
    // History should be monotonically increasing in x for a steady walk.
    for (let i = 1; i < h1Trail!.length; i += 1) {
      expect(h1Trail![i]!.x).toBeGreaterThanOrEqual(h1Trail![i - 1]!.x);
    }
  });

  it('keeps lastAppliedSeq monotonic per player', () => {
    const room = makeRoom();
    setPhase(room, 'free_roam');
    placeHuman(room, 'h1', 'mime', 0, 0);
    placeHuman(room, 'h2', 'clown', 10, 10);
    for (let seq = 1; seq <= 5; seq += 1) {
      queueInput(room, 'h1', {
        seq,
        dt: 1 / 60,
        move: { x: 1, z: 0 },
        lookYaw: 0,
        sprint: false,
        nowMs: Date.now(),
      });
      queueInput(room, 'h2', {
        seq: seq * 10,
        dt: 1 / 60,
        move: { x: -1, z: 0 },
        lookYaw: 0,
        sprint: false,
        nowMs: Date.now(),
      });
      callSimulate(room);
      vi.advanceTimersByTime(1000 / 60);
    }
    const lastApplied = (room as unknown as { lastAppliedSeq: Map<string, number> }).lastAppliedSeq;
    expect(lastApplied.get('h1')).toBe(5);
    expect(lastApplied.get('h2')).toBe(50);
  });

  it('produces identical outputs for two runs of the same seeded scenario', () => {
    const setupAndRun = (): PlayerState => {
      vi.setSystemTime(new Date('2026-05-28T00:00:00Z'));
      const room = makeRoom();
      setPhase(room, 'free_roam');
      placeHuman(room, 'h1', 'mime', 1.5, -2.5);
      for (let seq = 1; seq <= 30; seq += 1) {
        queueInput(room, 'h1', {
          seq,
          dt: 1 / 60,
          move: { x: 0.6, z: -0.4 },
          lookYaw: 0,
          sprint: false,
          nowMs: Date.now(),
        });
        callSimulate(room);
        vi.advanceTimersByTime(1000 / 60);
      }
      return (room as unknown as { players: Map<string, PlayerState> }).players.get('h1')!;
    };
    const a = setupAndRun();
    const b = setupAndRun();
    expect(a.position).toEqual(b.position);
    expect(a.sprintEnergy).toBe(b.sprintEnergy);
    expect(a.sprinting).toBe(b.sprinting);
  });

  it('leaves a frozen human at rest regardless of inputs', () => {
    const room = makeRoom();
    setPhase(room, 'free_roam');
    const h1 = placeHuman(room, 'h1', 'mime', 0, 0);
    h1.frozen = true;
    const startPos = { ...h1.position };
    for (let seq = 1; seq <= 60; seq += 1) {
      queueInput(room, 'h1', {
        seq,
        dt: 1 / 60,
        move: { x: 1, z: 1 },
        lookYaw: 0,
        sprint: true,
        nowMs: Date.now(),
      });
      callSimulate(room);
      vi.advanceTimersByTime(1000 / 60);
    }
    const after = (room as unknown as { players: Map<string, PlayerState> }).players.get('h1')!;
    expect(after.position.x).toBe(startPos.x);
    expect(after.position.z).toBe(startPos.z);
  });

  it('still advances lastAppliedSeq for a frozen player so the client can prune', () => {
    // Regression for the 2026-05-29 freeze: a frozen player's inputs were
    // drained without updating lastAppliedSeq, so every delta's ackSeq
    // stayed stuck at the value-at-freeze. The client's pending_inputs
    // buffer grew unboundedly at ~60/s and reconcile() replays became
    // O(N), tanking the frame rate within ~90 s. Drain must still ack.
    const room = makeRoom();
    setPhase(room, 'free_roam');
    const h1 = placeHuman(room, 'h1', 'mime', 0, 0);
    h1.frozen = true;
    for (let seq = 1; seq <= 60; seq += 1) {
      queueInput(room, 'h1', {
        seq,
        dt: 1 / 60,
        move: { x: 0, z: 0 },
        lookYaw: 0,
        sprint: false,
        nowMs: Date.now(),
      });
      callSimulate(room);
      vi.advanceTimersByTime(1000 / 60);
    }
    const lastApplied = (room as unknown as { lastAppliedSeq: Map<string, number> }).lastAppliedSeq;
    // After 60 ticks each with seq 1..60, the ack should sit at 60.
    // (Whether the player moved is asserted by the prior test; this one
    // only cares that the seq advanced.)
    expect(lastApplied.get('h1')).toBe(60);
  });
});
