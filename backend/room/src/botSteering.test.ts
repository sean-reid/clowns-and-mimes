import { describe, expect, it } from 'vitest';
import type { WallSegment } from '@cm/shared/labyrinth';
import { smoothDir, stepWithSlide, turnToward } from './botSteering.ts';

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
