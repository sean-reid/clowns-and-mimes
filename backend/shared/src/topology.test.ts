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

  it('flips z when wrapping x on klein bottle', () => {
    const a = wrapPosition({ x: 60, z: 20 }, 'klein', W);
    expect(a.x).toBe(-40);
    expect(a.z).toBe(-20);
  });

  it('does not flip z when only wrapping z on klein bottle', () => {
    const a = wrapPosition({ x: 0, z: 60 }, 'klein', W);
    expect(a.x).toBe(0);
    expect(a.z).toBe(-40);
  });

  it('wraps both axes torus-like on sphere (cube-mapped first cut)', () => {
    // First cut packs six cube faces 3x2 across the full WIDTH. A simple
    // modular wrap matches the visual seam crossings; proper cube edge
    // rotations are a follow-up.
    const a = wrapPosition({ x: 60, z: 0 }, 'sphere', W);
    expect(a.x).toBeCloseTo(-40, 6);
    const b = wrapPosition({ x: 0, z: -60 }, 'sphere', W);
    expect(b.z).toBeCloseTo(40, 6);
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
