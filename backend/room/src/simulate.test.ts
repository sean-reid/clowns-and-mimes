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

interface MockState {
  id: { toString: () => string };
  acceptWebSocket: (ws: WebSocket) => void;
  storage: Map<string, unknown>;
}

function makeMockState(roomId = 'test-room-0001'): MockState {
  return {
    id: { toString: () => roomId },
    acceptWebSocket: () => {
      // Not used by simulate path; only fetch() calls it.
    },
    storage: new Map(),
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
  (room as unknown as { simulate: () => void }).simulate();
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
});
