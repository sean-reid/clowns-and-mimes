import { describe, expect, it } from 'vitest';
import type { WallSegment } from '@cm/shared/labyrinth';
import { passBiasDir, smoothDir, stabilizeYaw, stepWithSlide, turnToward } from './botSteering.ts';

describe('smoothDir', () => {
  it('returns the normalized raw direction when there is no prior direction', () => {
    const d = smoothDir({ x: 0, z: 0 }, { x: 3, z: 4 }, 0.5);
    expect(d.x).toBeCloseTo(0.6, 6);
    expect(d.z).toBeCloseTo(0.8, 6);
  });

  it('blends toward the prior direction by the smoothing factor, then renormalizes', () => {
    // last=+x, raw=+z, smoothing 0.5 -> (0.5, 0.5) -> normalized to 45deg.
    const d = smoothDir({ x: 1, z: 0 }, { x: 0, z: 1 }, 0.5);
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(d.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('collapses to zero when the blend cancels out', () => {
    const d = smoothDir({ x: 1, z: 0 }, { x: -1, z: 0 }, 0.5);
    expect(d).toEqual({ x: 0, z: 0 });
  });
});

describe('stepWithSlide', () => {
  it('takes the full diagonal step when nothing blocks it', () => {
    const r = stepWithSlide({ x: 0, z: 0 }, { x: 1, z: 0 }, 2, [], 'plane', 80);
    expect(r.moved).toBe(true);
    expect(r.x).toBeCloseTo(2, 6);
    expect(r.z).toBeCloseTo(0, 6);
  });

  it('slides along x when the diagonal is blocked but the x move is clear', () => {
    // Wall on the line z=1, blocking both the diagonal and the z-only
    // candidate (each crosses it) and leaving the x-only slide.
    const walls: WallSegment[] = [{ ax: -5, az: 1, bx: 5, bz: 1 }];
    const r = stepWithSlide({ x: 0, z: 0 }, { x: 1, z: 1 }, 2, walls, 'plane', 80);
    expect(r.moved).toBe(true);
    expect(r.z).toBeCloseTo(0, 6); // did not cross the z=1 wall
    expect(r.x).toBeGreaterThan(0);
  });

  it('reports no movement when every candidate is blocked', () => {
    // Box the origin in: walls on all four sides at distance 0.5.
    const walls: WallSegment[] = [
      { ax: -1, az: 0.5, bx: 1, bz: 0.5 },
      { ax: -1, az: -0.5, bx: 1, bz: -0.5 },
      { ax: 0.5, az: -1, bx: 0.5, bz: 1 },
      { ax: -0.5, az: -1, bx: -0.5, bz: 1 },
    ];
    const r = stepWithSlide({ x: 0, z: 0 }, { x: 1, z: 1 }, 2, walls, 'plane', 80);
    expect(r.moved).toBe(false);
    expect(r.x).toBe(0);
    expect(r.z).toBe(0);
  });

  it('rounds a wall tip with a rotated heading when the axis slides are blocked', () => {
    // Vertical wall x = 0 spanning z in [-10, 0], tip at (0, 0). The bot is just
    // left of it and wants to cross to the right (+x). The full move and the
    // x-only slide both tunnel through the wall, and dir has no z component to
    // slide on - so the only way through is the rotated fallback, which veers
    // +z to get around the tip.
    const walls: WallSegment[] = [{ ax: 0, az: -10, bx: 0, bz: 0 }];
    const r = stepWithSlide({ x: -0.3, z: -2 }, { x: 1, z: 0 }, 2, walls, 'plane', 80);
    expect(r.moved).toBe(true);
    expect(r.x).toBeLessThanOrEqual(0); // did not tunnel through to the far side
    expect(r.z).toBeGreaterThan(-2); // veered toward the tip to round it
  });

  it('wraps the resulting position to canonical coords on a torus', () => {
    // Near the +x edge (half-width 40), step past it; torus wraps to -x side.
    const r = stepWithSlide({ x: 39.5, z: 0 }, { x: 1, z: 0 }, 2, [], 'torus', 80);
    expect(r.moved).toBe(true);
    expect(r.x).toBeLessThan(0);
  });
});

describe('turnToward', () => {
  it('clamps the turn to maxRate * dt', () => {
    const y = turnToward(0, Math.PI, 1.0, 0.1); // wants PI, allowed 0.1
    expect(y).toBeCloseTo(0.1, 6);
  });

  it('takes the shortest path across the +/-PI seam', () => {
    // 3.0 -> -3.0 the short way is +0.283 (delta -6 wraps to +0.283), landing
    // at 3.283, which is the same heading as -3.0. Yaw is left unnormalized,
    // matching the original loop.
    const y = turnToward(3.0, -3.0, 100, 1); // huge maxStep so it reaches target
    expect(y).toBeCloseTo(3.0 + (2 * Math.PI - 6.0), 6);
  });

  it('reaches the target when within the per-tick budget', () => {
    const y = turnToward(0, 0.05, 1.0, 0.1); // budget 0.1 > 0.05
    expect(y).toBeCloseTo(0.05, 6);
  });
});

describe('stabilizeYaw', () => {
  // deadband 0.06, reversalBreak 0.6, commitTicks 10
  const DB = 0.06;
  const BREAK = 0.6;
  const HOLD = 10;

  it('ignores a re-aim smaller than the deadband and winds down the hold', () => {
    const r = stabilizeYaw(1.0, 4, 1.0 + 0.03, DB, BREAK, HOLD);
    expect(r.yaw).toBe(1.0);
    expect(r.holdTicks).toBe(3);
  });

  it('holds the committed heading against a mid-size reversal inside the commit window', () => {
    const r = stabilizeYaw(1.0, 5, 1.0 + 0.3, DB, BREAK, HOLD);
    expect(r.yaw).toBe(1.0);
    expect(r.holdTicks).toBe(4);
  });

  it('adopts a mid-size change once the hold has expired', () => {
    const r = stabilizeYaw(1.0, 0, 1.0 + 0.3, DB, BREAK, HOLD);
    expect(r.yaw).toBeCloseTo(1.3, 6);
    expect(r.holdTicks).toBe(HOLD);
  });

  it('adopts a change at or above the reversal break immediately, even mid-hold', () => {
    const r = stabilizeYaw(1.0, 8, 1.0 + 0.8, DB, BREAK, HOLD);
    expect(r.yaw).toBeCloseTo(1.8, 6);
    expect(r.holdTicks).toBe(HOLD);
  });

  it('measures the change across the +/-PI seam', () => {
    // target ~PI, raw just past -PI: shortest delta is small, so it holds.
    const r = stabilizeYaw(Math.PI - 0.02, 6, -Math.PI + 0.02, DB, BREAK, HOLD);
    expect(r.yaw).toBe(Math.PI - 0.02);
    expect(r.holdTicks).toBe(5);
  });

  it('never drives the hold negative', () => {
    const r = stabilizeYaw(1.0, 0, 1.0, DB, BREAK, HOLD);
    expect(r.holdTicks).toBe(0);
  });
});

describe('passBiasDir', () => {
  it('veers to the right of a neighbour sitting dead ahead', () => {
    // dir=+x, neighbour 2 ahead, radius 4, weight 1 -> lateral 0.5 toward +z
    // (the right-hand perpendicular of +x). blend (1, 0.5) normalizes.
    const d = passBiasDir({ x: 1, z: 0 }, [{ x: 2, z: 0 }], 4, 1);
    expect(d.x).toBeCloseTo(0.894427, 5);
    expect(d.z).toBeCloseTo(0.447214, 5);
  });

  it('sends two head-on bots to opposite sides so they pass', () => {
    // Bot A faces +x and sees B 2 units ahead; Bot B faces -x and sees A 2
    // units ahead. Same rule, mirrored frames -> A swerves +z, B swerves -z.
    const a = passBiasDir({ x: 1, z: 0 }, [{ x: 2, z: 0 }], 4, 1);
    const b = passBiasDir({ x: -1, z: 0 }, [{ x: -2, z: 0 }], 4, 1);
    expect(a.z).toBeGreaterThan(0);
    expect(b.z).toBeLessThan(0);
    expect(a.z).toBeCloseTo(-b.z, 6);
  });

  it('ignores a neighbour behind the heading', () => {
    const d = passBiasDir({ x: 1, z: 0 }, [{ x: -2, z: 0 }], 4, 1);
    expect(d.x).toBeCloseTo(1, 6);
    expect(d.z).toBeCloseTo(0, 6);
  });

  it('ignores a neighbour beyond the radius', () => {
    const d = passBiasDir({ x: 1, z: 0 }, [{ x: 5, z: 0 }], 4, 1);
    expect(d.x).toBeCloseTo(1, 6);
    expect(d.z).toBeCloseTo(0, 6);
  });

  it('returns the heading unchanged when there are no neighbours', () => {
    const d = passBiasDir({ x: 0, z: 1 }, [], 4, 1);
    expect(d).toEqual({ x: 0, z: 1 });
  });

  it('returns a degenerate heading unchanged', () => {
    const d = passBiasDir({ x: 0, z: 0 }, [{ x: 1, z: 0 }], 4, 1);
    expect(d).toEqual({ x: 0, z: 0 });
  });

  it('pushes harder the closer the neighbour', () => {
    const near = passBiasDir({ x: 1, z: 0 }, [{ x: 1, z: 0 }], 4, 1);
    const far = passBiasDir({ x: 1, z: 0 }, [{ x: 3, z: 0 }], 4, 1);
    // Both veer +z; the nearer neighbour produces the larger lateral component.
    expect(near.z).toBeGreaterThan(far.z);
  });
});
