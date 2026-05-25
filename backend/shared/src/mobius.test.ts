import { describe, expect, it } from 'vitest';
import {
  MOBIUS_HALF_X,
  MOBIUS_HALF_Z,
  MOBIUS_PORTAL_LEFT,
  MOBIUS_PORTAL_RIGHT,
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
  it('contains the origin', () => {
    expect(pointInMobius({ x: 0, z: 0 })).toBe(true);
  });

  it('contains points up to the boundary', () => {
    expect(pointInMobius({ x: MOBIUS_HALF_X, z: 0 })).toBe(true);
    expect(pointInMobius({ x: -MOBIUS_HALF_X, z: 0 })).toBe(true);
    expect(pointInMobius({ x: 0, z: MOBIUS_HALF_Z })).toBe(true);
    expect(pointInMobius({ x: 0, z: -MOBIUS_HALF_Z })).toBe(true);
  });

  it('excludes points past the x or z boundary', () => {
    expect(pointInMobius({ x: MOBIUS_HALF_X + 1, z: 0 })).toBe(false);
    expect(pointInMobius({ x: 0, z: MOBIUS_HALF_Z + 1 })).toBe(false);
    expect(pointInMobius({ x: 0, z: -MOBIUS_HALF_Z - 1 })).toBe(false);
  });
});

describe('stepAcrossMobiusBoundary', () => {
  it('returns next unchanged inside the strip', () => {
    const prev = { x: 0, z: 0 };
    const next = { x: 5, z: -3 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBeCloseTo(next.x, 6);
    expect(out.z).toBeCloseTo(next.z, 6);
  });

  it('wraps east with z negated when crossing the +x edge', () => {
    const prev = { x: MOBIUS_HALF_X - 0.5, z: 5 };
    const next = { x: MOBIUS_HALF_X + 0.3, z: 5 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBeLessThan(0); // landed on the far left
    expect(out.z).toBeLessThan(0); // z was flipped from +5 to negative
    expect(out.z).toBeCloseTo(-5, 0); // approximately -5 modulo the safe-nudge
  });

  it('wraps west with z negated when crossing the -x edge', () => {
    const prev = { x: -MOBIUS_HALF_X + 0.5, z: -7 };
    const next = { x: -MOBIUS_HALF_X - 0.3, z: -7 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBeGreaterThan(0); // landed on the far right
    expect(out.z).toBeCloseTo(7, 0); // z flipped sign
  });

  it('blocks the step entirely when next is past the top hard wall', () => {
    const prev = { x: 0, z: MOBIUS_HALF_Z - 0.1 };
    const next = { x: 0, z: MOBIUS_HALF_Z + 1 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBe(prev.x);
    expect(out.z).toBe(prev.z);
  });

  it('blocks the step entirely when next is past the bottom hard wall', () => {
    const prev = { x: 0, z: -MOBIUS_HALF_Z + 0.1 };
    const next = { x: 0, z: -MOBIUS_HALF_Z - 1 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBe(prev.x);
    expect(out.z).toBe(prev.z);
  });

  it('safe-nudges destinations clear of the receiving wall', () => {
    // The overshoot is tiny but the destination must end up SAFE_INWARD
    // units off the receiving edge so the next tick's wall check doesn't
    // pin the player against the maze wall along the boundary.
    const prev = { x: MOBIUS_HALF_X - 0.1, z: 0 };
    const next = { x: MOBIUS_HALF_X + 0.01, z: 0 };
    const out = stepAcrossMobiusBoundary(prev, next);
    // We came in from the east; destination is on the west side, at least
    // 0.65 in from x = -MOBIUS_HALF_X.
    expect(out.x).toBeGreaterThan(-MOBIUS_HALF_X + 0.6);
  });
});

describe('wrapMobiusPoint', () => {
  it('returns interior points unchanged', () => {
    const p = { x: 3, z: -2 };
    const out = wrapMobiusPoint(p);
    expect(out).toEqual(p);
  });

  it('wraps an exterior point with the z-flip', () => {
    const out = wrapMobiusPoint({ x: MOBIUS_HALF_X + 5, z: 3 });
    expect(out.x).toBeLessThan(0);
    expect(out.z).toBeCloseTo(-3, 6);
  });

  it('clamps a z-exterior point to the boundary', () => {
    const out = wrapMobiusPoint({ x: 0, z: MOBIUS_HALF_Z + 100 });
    expect(out.x).toBe(0);
    expect(out.z).toBe(MOBIUS_HALF_Z);
  });
});

describe('mobius portal transforms', () => {
  it('right portal translates by +2*MOBIUS_HALF_X and flips z', () => {
    expect(MOBIUS_PORTAL_RIGHT.tx).toBe(2 * MOBIUS_HALF_X);
    expect(MOBIUS_PORTAL_RIGHT.flipZ).toBe(true);
  });

  it('left portal translates by -2*MOBIUS_HALF_X and flips z', () => {
    expect(MOBIUS_PORTAL_LEFT.tx).toBe(-2 * MOBIUS_HALF_X);
    expect(MOBIUS_PORTAL_LEFT.flipZ).toBe(true);
  });

  it('applying right portal to the left edge places it at the right boundary', () => {
    // V_left = (-MOBIUS_HALF_X, 0). Apply T_right: (V_left.x + 2*Lx, -V_left.z)
    // = (-Lx + 2*Lx, 0) = (Lx, 0). This matches V_right and lines the strip
    // up so the player sees continuous geometry past the right edge.
    const Vleft = { x: -MOBIUS_HALF_X, z: 0 };
    const Vimg = {
      x: Vleft.x + MOBIUS_PORTAL_RIGHT.tx,
      z: MOBIUS_PORTAL_RIGHT.flipZ ? -Vleft.z : Vleft.z,
    };
    expect(Vimg.x).toBeCloseTo(MOBIUS_HALF_X, 6);
    expect(Vimg.z).toBeCloseTo(0, 6);
  });
});
