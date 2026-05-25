import { describe, expect, it } from 'vitest';
import {
  MOBIUS_HALF_X,
  MOBIUS_HALF_Z,
  mobiusExtents,
  pointInMobius,
  stepAcrossMobiusBoundary,
  wrapMobiusPoint,
} from './mobius.ts';

describe('mobiusExtents', () => {
  it('returns 2 * MOBIUS_HALF_X by 2 * MOBIUS_HALF_Z', () => {
    const ext = mobiusExtents();
    expect(ext.x).toBe(2 * MOBIUS_HALF_X);
    expect(ext.z).toBe(2 * MOBIUS_HALF_Z);
  });
});

describe('pointInMobius', () => {
  it('accepts any z inside the strip regardless of x (x is modular)', () => {
    expect(pointInMobius({ x: 0, z: 0 })).toBe(true);
    expect(pointInMobius({ x: 200, z: 0 })).toBe(true);
    expect(pointInMobius({ x: -200, z: MOBIUS_HALF_Z })).toBe(true);
  });

  it('rejects points past the z hard bounds', () => {
    expect(pointInMobius({ x: 0, z: MOBIUS_HALF_Z + 0.1 })).toBe(false);
    expect(pointInMobius({ x: 0, z: -MOBIUS_HALF_Z - 0.1 })).toBe(false);
  });
});

describe('stepAcrossMobiusBoundary', () => {
  it('returns next unchanged inside the strip', () => {
    const out = stepAcrossMobiusBoundary({ x: 0, z: 0 }, { x: 5, z: -3 });
    expect(out.x).toBeCloseTo(5, 6);
    expect(out.z).toBeCloseTo(-3, 6);
  });

  it('wraps x modular at the right edge with NO z-flip', () => {
    // Cross x = +MOBIUS_HALF_X by 0.3. Emerge on the far left with the
    // same z; the Möbius flip is encoded in the maze geometry, not in
    // the wrap rule, so player motion across the seam is smooth.
    const prev = { x: MOBIUS_HALF_X - 0.1, z: 7 };
    const next = { x: MOBIUS_HALF_X + 0.3, z: 7 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBeCloseTo(-MOBIUS_HALF_X + 0.3, 6);
    expect(out.z).toBeCloseTo(7, 6);
  });

  it('wraps x modular at the left edge with NO z-flip', () => {
    const prev = { x: -MOBIUS_HALF_X + 0.1, z: -7 };
    const next = { x: -MOBIUS_HALF_X - 0.3, z: -7 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBeCloseTo(MOBIUS_HALF_X - 0.3, 6);
    expect(out.z).toBeCloseTo(-7, 6);
  });

  it('blocks the step past the top hard wall', () => {
    const prev = { x: 0, z: MOBIUS_HALF_Z - 0.1 };
    const next = { x: 0, z: MOBIUS_HALF_Z + 1 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out).toEqual(prev);
  });

  it('blocks the step past the bottom hard wall', () => {
    const prev = { x: 0, z: -MOBIUS_HALF_Z + 0.1 };
    const next = { x: 0, z: -MOBIUS_HALF_Z - 1 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out).toEqual(prev);
  });
});

describe('wrapMobiusPoint', () => {
  it('returns interior points with x wrapped modular', () => {
    expect(wrapMobiusPoint({ x: 3, z: -2 })).toEqual({ x: 3, z: -2 });
    expect(wrapMobiusPoint({ x: MOBIUS_HALF_X + 5, z: 0 }).x).toBeCloseTo(-MOBIUS_HALF_X + 5, 6);
  });

  it('clamps a z-exterior point to the boundary', () => {
    expect(wrapMobiusPoint({ x: 0, z: MOBIUS_HALF_Z + 100 })).toEqual({
      x: 0,
      z: MOBIUS_HALF_Z,
    });
    expect(wrapMobiusPoint({ x: 0, z: -MOBIUS_HALF_Z - 100 })).toEqual({
      x: 0,
      z: -MOBIUS_HALF_Z,
    });
  });
});
