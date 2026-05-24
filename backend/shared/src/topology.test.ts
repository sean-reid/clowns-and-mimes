import { describe, expect, it } from 'vitest';
import { topologyDistance, wrapPosition } from './topology.ts';

const W = 100;

describe('wrapPosition', () => {
  it('clamps to bounds on plane', () => {
    expect(wrapPosition({ x: 200, z: -200 }, 'plane', W)).toEqual({ x: 50, z: -50 });
    expect(wrapPosition({ x: 10, z: 10 }, 'plane', W)).toEqual({ x: 10, z: 10 });
  });

  it('wraps both axes on torus', () => {
    expect(wrapPosition({ x: 60, z: 0 }, 'torus', W)).toEqual({ x: -40, z: 0 });
    expect(wrapPosition({ x: 0, z: -60 }, 'torus', W)).toEqual({ x: 0, z: 40 });
  });

  it('wraps with period 2W in x on klein bottle (double cover)', () => {
    // x stays in [-W, W] (period 2W); the z-mirror of the right half is in
    // the geometry, not in wrap. Position 60 with W=100 is inside the
    // double cover and is not wrapped.
    const a = wrapPosition({ x: 60, z: 20 }, 'klein', W);
    expect(a.x).toBe(60);
    expect(a.z).toBe(20);
    // Past the 2W seam at x=100, wrap pulls back across the full double
    // cover (200 wide) without touching z.
    const b = wrapPosition({ x: 110, z: 20 }, 'klein', W);
    expect(b.x).toBe(-90);
    expect(b.z).toBe(20);
  });

  it('wraps z with period W on klein bottle', () => {
    const a = wrapPosition({ x: 0, z: 60 }, 'klein', W);
    expect(a.x).toBe(0);
    expect(a.z).toBe(-40);
  });

  it('passes through on the sphere when the point is on a valid face', () => {
    // Sphere is the T-net cube map: 4*W/4 wide x 3*W/4 tall (100 x 75 here).
    // A point inside a face slot is returned unchanged; the step-aware
    // wrap (wrapPositionFromStep) handles cube adjacency on motion.
    const inside = wrapPosition({ x: 10, z: 5 }, 'sphere', W);
    expect(inside.x).toBe(10);
    expect(inside.z).toBe(5);
  });

  it('snaps an out-of-bounds sphere point to the nearest face center', () => {
    // (60, 0) is outside the T-net (x range [-50, 50]). Nearest face slot
    // is the equator's +X at col=2, row=1: center (37.5, 0).
    const out = wrapPosition({ x: 60, z: 0 }, 'sphere', W);
    expect(out.x).toBeCloseTo(37.5, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });
});

describe('topologyDistance', () => {
  it('uses straight-line distance on plane', () => {
    expect(topologyDistance({ x: 0, z: 0 }, { x: 3, z: 4 }, 'plane', W)).toBeCloseTo(5);
  });

  it('takes shortest wrap on torus', () => {
    const d = topologyDistance({ x: -45, z: 0 }, { x: 45, z: 0 }, 'torus', W);
    expect(d).toBeCloseTo(10);
  });
});
