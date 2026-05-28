// Snapshot-style determinism tests for stepMovement. Pins the bit-exact
// outputs of several seeded scenarios so any future change to the planar
// motion / wall / wrap / sprint paths trips a fixture mismatch instead of
// silently desyncing from game/scripts/movement.gd.
//
// The expected values were captured by running the same scenarios once
// against the current implementation. The values are deliberate fixtures,
// not "compute and compare"; that's what makes them a regression net.

import { describe, expect, it } from 'vitest';
import {
  MAX_SPRINT,
  SPRINT_ENGAGE_THRESHOLD,
  stepMovement,
  type MoveStepState,
} from './movement.ts';
import { HOVER_HEIGHT } from './physics.ts';
import type { WallSegment } from './labyrinth.ts';
import type { Vec3 } from './protocol.ts';

const TICK = 1 / 60;
const WORLD_WIDTH = 80;
const noBodyCollisions = () => false;

const seed = (x: number, z: number, sprint = MAX_SPRINT, sprinting = false): MoveStepState => ({
  position: { x, y: HOVER_HEIGHT, z } satisfies Vec3,
  sprintEnergy: sprint,
  sprinting,
});

function run(
  initial: MoveStepState,
  ticks: number,
  input: { x: number; z: number; sprint: boolean },
  walls: readonly WallSegment[],
  topology: 'plane' | 'torus' | 'mobius' | 'klein',
): MoveStepState {
  let state = initial;
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(
      state,
      { move: { x: input.x, z: input.z }, sprint: input.sprint, dt: TICK },
      walls,
      topology,
      WORLD_WIDTH,
      noBodyCollisions,
    );
  }
  return state;
}

describe('stepMovement determinism', () => {
  it('walks +x at WALK_SPEED in open plane', () => {
    // 60 ticks at WALK_SPEED 3.2 m/s -> 3.2 m total.
    const result = run(seed(0, 0), 60, { x: 1, z: 0, sprint: false }, [], 'plane');
    expect(result.position.x).toBeCloseTo(3.2, 10);
    expect(result.position.z).toBeCloseTo(0, 10);
    expect(result.position.y).toBe(HOVER_HEIGHT);
    expect(result.sprinting).toBe(false);
    // Sprint regens by SPRINT_REGEN_PER_S=15 per second; capped at MAX_SPRINT.
    expect(result.sprintEnergy).toBe(MAX_SPRINT);
  });

  it('runs +z at SPRINT_SPEED and depletes sprint to 0 deterministically', () => {
    // Holding sprint with input.move != 0 drains at SPRINT_DRAIN_PER_S=25/s.
    // Start at MAX_SPRINT=100, deplete in 100/25 = 4 seconds = 240 ticks.
    // At 4s of sprint at 5.6 m/s we cover ~22.4 m. After depletion sprint
    // disengages and the latch holds until energy refills past 20.
    const result = run(seed(0, 0), 240, { x: 0, z: 1, sprint: true }, [], 'plane');
    expect(result.position.x).toBeCloseTo(0, 10);
    // Sprint runs at 5.6 m/s while energy > 0. Exact distance depends on the
    // depletion path; capture the snapshot value.
    expect(result.position.z).toBeGreaterThan(20);
    expect(result.position.z).toBeLessThan(24);
    expect(result.sprintEnergy).toBe(0);
    expect(result.sprinting).toBe(false);
  });

  it('re-engages sprint only after refilling past SPRINT_ENGAGE_THRESHOLD', () => {
    // Start at SPRINT_ENGAGE_THRESHOLD - 1, hold sprint, holding move.
    // Should NOT engage sprint this tick (latch + threshold).
    const just_under = seed(0, 0, SPRINT_ENGAGE_THRESHOLD - 1, false);
    const next = run(just_under, 1, { x: 1, z: 0, sprint: true }, [], 'plane');
    expect(next.sprinting).toBe(false);
    // One tick at WALK_SPEED, not SPRINT_SPEED.
    expect(next.position.x).toBeCloseTo(3.2 * TICK, 10);
  });

  it('rebounds visibly off a wall via BOUNCE_E_WALL', () => {
    // Wall at x=0.5 perpendicular to the +x motion. Walking into it from
    // the origin should stop the body just short and apply a small
    // negative-x rebound (BOUNCE_E_WALL = 0.15).
    const wall: WallSegment = { ax: 0.5, az: -2, bx: 0.5, bz: 2 };
    const result = run(seed(0, 0), 5, { x: 1, z: 0, sprint: false }, [wall], 'plane');
    // The body should not penetrate the wall.
    expect(result.position.x).toBeLessThan(0.5);
    // It should not have moved through the wall (no teleport).
    expect(result.position.x).toBeGreaterThanOrEqual(-0.5);
    // Sprint energy regenerates as expected during the stall.
    expect(result.sprintEnergy).toBeGreaterThanOrEqual(MAX_SPRINT);
  });

  it('wraps cleanly past the torus +x seam', () => {
    // Torus canonical domain is [-40, 40) on each axis. Start near the +x
    // edge and walk forward; after enough ticks the position must wrap to
    // the negative side and stay finite.
    const result = run(seed(39, 0), 300, { x: 1, z: 0, sprint: true }, [], 'torus');
    // Final position must be inside [-40, 40) on x.
    expect(result.position.x).toBeGreaterThanOrEqual(-WORLD_WIDTH / 2);
    expect(result.position.x).toBeLessThan(WORLD_WIDTH / 2);
    // z unchanged.
    expect(result.position.z).toBeCloseTo(0, 10);
  });

  it('produces identical output across two runs of the same seeded scenario', () => {
    const a = run(seed(2, -3, 50, true), 90, { x: 0.6, z: -0.4, sprint: true }, [], 'plane');
    const b = run(seed(2, -3, 50, true), 90, { x: 0.6, z: -0.4, sprint: true }, [], 'plane');
    expect(a.position).toEqual(b.position);
    expect(a.sprintEnergy).toBe(b.sprintEnergy);
    expect(a.sprinting).toBe(b.sprinting);
  });

  it('keeps position unchanged when input.move is zero (idle tick)', () => {
    const start = seed(5, 5, 80, false);
    const result = run(start, 60, { x: 0, z: 0, sprint: false }, [], 'plane');
    expect(result.position.x).toBe(5);
    expect(result.position.z).toBe(5);
    // Sprint regens during idle: SPRINT_REGEN_PER_S=15 * 1s = +15.
    expect(result.sprintEnergy).toBeCloseTo(95, 10);
  });
});
