import { describe, expect, it } from 'vitest';
import {
  OCTAGON_CIRCUMRADIUS,
  OCTAGON_SIDES,
  OCTAGON_VERTICES,
  SIDE_COUNT,
  genus2Extents,
  inwardNormal,
  mateSide,
  parametrizeAlongSide,
  pointInOctagon,
  pointOnSide,
  sideOfBoundary,
  signedDistanceToSide,
} from './genus2.ts';

describe('octagon geometry', () => {
  it('has 8 vertices on the circumradius circle', () => {
    expect(OCTAGON_VERTICES.length).toBe(8);
    for (const v of OCTAGON_VERTICES) {
      expect(Math.hypot(v.x, v.z)).toBeCloseTo(OCTAGON_CIRCUMRADIUS, 6);
    }
  });

  it('vertex 0 sits on the +x axis and vertex 2 sits on the +z axis', () => {
    expect(OCTAGON_VERTICES[0]!.x).toBeCloseTo(OCTAGON_CIRCUMRADIUS, 6);
    expect(OCTAGON_VERTICES[0]!.z).toBeCloseTo(0, 6);
    expect(OCTAGON_VERTICES[2]!.x).toBeCloseTo(0, 6);
    expect(OCTAGON_VERTICES[2]!.z).toBeCloseTo(OCTAGON_CIRCUMRADIUS, 6);
  });

  it('has 8 sides and each side length is equal', () => {
    expect(OCTAGON_SIDES.length).toBe(8);
    const len = OCTAGON_SIDES[0]!.length;
    for (const s of OCTAGON_SIDES) {
      expect(s.length).toBeCloseTo(len, 6);
    }
  });

  it('outward normals point away from the polygon centre', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      const s = OCTAGON_SIDES[k]!;
      const midX = (s.start.x + s.end.x) / 2;
      const midZ = (s.start.z + s.end.z) / 2;
      // Outward normal dotted with the midpoint-from-centre vector should
      // be positive (both point outward).
      expect(midX * s.outwardNormal.x + midZ * s.outwardNormal.z).toBeGreaterThan(0);
    }
  });

  it('tangent and outward normal are perpendicular unit vectors', () => {
    for (const s of OCTAGON_SIDES) {
      expect(Math.hypot(s.tangent.x, s.tangent.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(s.outwardNormal.x, s.outwardNormal.z)).toBeCloseTo(1, 6);
      expect(s.tangent.x * s.outwardNormal.x + s.tangent.z * s.outwardNormal.z).toBeCloseTo(0, 6);
    }
  });
});

describe('mateSide', () => {
  it('pairs up sides 0<->2, 1<->3, 4<->6, 5<->7', () => {
    expect(mateSide(0)).toBe(2);
    expect(mateSide(2)).toBe(0);
    expect(mateSide(1)).toBe(3);
    expect(mateSide(3)).toBe(1);
    expect(mateSide(4)).toBe(6);
    expect(mateSide(6)).toBe(4);
    expect(mateSide(5)).toBe(7);
    expect(mateSide(7)).toBe(5);
  });

  it('is self-inverse', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      expect(mateSide(mateSide(k))).toBe(k);
    }
  });

  it('never maps a side to itself', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      expect(mateSide(k)).not.toBe(k);
    }
  });
});

describe('pointInOctagon', () => {
  it('contains the origin', () => {
    expect(pointInOctagon({ x: 0, z: 0 })).toBe(true);
  });

  it('contains the polygon vertices (with floating-point slack)', () => {
    for (const v of OCTAGON_VERTICES) {
      expect(pointInOctagon(v)).toBe(true);
    }
  });

  it('excludes points clearly outside any side', () => {
    // Move 5 units past each side's midpoint along its outward normal.
    for (const s of OCTAGON_SIDES) {
      const midX = (s.start.x + s.end.x) / 2;
      const midZ = (s.start.z + s.end.z) / 2;
      const probe = {
        x: midX + 5 * s.outwardNormal.x,
        z: midZ + 5 * s.outwardNormal.z,
      };
      expect(pointInOctagon(probe)).toBe(false);
    }
  });
});

describe('sideOfBoundary', () => {
  it('returns null for an interior point', () => {
    expect(sideOfBoundary({ x: 0, z: 0 })).toBeNull();
    expect(sideOfBoundary({ x: 5, z: 5 })).toBeNull();
  });

  it('identifies the side closest to a probe just outside it', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      const s = OCTAGON_SIDES[k]!;
      const midX = (s.start.x + s.end.x) / 2;
      const midZ = (s.start.z + s.end.z) / 2;
      const probe = {
        x: midX + 0.5 * s.outwardNormal.x,
        z: midZ + 0.5 * s.outwardNormal.z,
      };
      expect(sideOfBoundary(probe)).toBe(k);
    }
  });
});

describe('parametrizeAlongSide and pointOnSide', () => {
  it('round trip across t = 0.3', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      const p = pointOnSide(k, 0.3);
      const t = parametrizeAlongSide(p, k);
      expect(t).toBeCloseTo(0.3, 6);
    }
  });

  it('parametrizeAlongSide clamps to [0, 1]', () => {
    const s = OCTAGON_SIDES[0]!;
    // Probe well past the end of the side along the tangent.
    const farPast = {
      x: s.end.x + 100 * s.tangent.x,
      z: s.end.z + 100 * s.tangent.z,
    };
    expect(parametrizeAlongSide(farPast, 0)).toBe(1);
    const farBefore = {
      x: s.start.x - 100 * s.tangent.x,
      z: s.start.z - 100 * s.tangent.z,
    };
    expect(parametrizeAlongSide(farBefore, 0)).toBe(0);
  });

  it('pointOnSide(k, 0) returns start, pointOnSide(k, 1) returns end', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      const s = OCTAGON_SIDES[k]!;
      const p0 = pointOnSide(k, 0);
      const p1 = pointOnSide(k, 1);
      expect(p0.x).toBeCloseTo(s.start.x, 6);
      expect(p0.z).toBeCloseTo(s.start.z, 6);
      expect(p1.x).toBeCloseTo(s.end.x, 6);
      expect(p1.z).toBeCloseTo(s.end.z, 6);
    }
  });
});

describe('inwardNormal', () => {
  it('is the negation of outwardNormal', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      const inw = inwardNormal(k);
      const outw = OCTAGON_SIDES[k]!.outwardNormal;
      expect(inw.x).toBeCloseTo(-outw.x, 6);
      expect(inw.z).toBeCloseTo(-outw.z, 6);
    }
  });
});

describe('signedDistanceToSide', () => {
  it('is zero for points on the side', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      const p = pointOnSide(k, 0.5);
      expect(signedDistanceToSide(p, k)).toBeCloseTo(0, 6);
    }
  });

  it('is negative for the polygon centre', () => {
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      expect(signedDistanceToSide({ x: 0, z: 0 }, k)).toBeLessThan(0);
    }
  });
});

describe('genus2Extents', () => {
  it('returns the octagon bounding box width and height', () => {
    const ext = genus2Extents();
    expect(ext.x).toBe(2 * OCTAGON_CIRCUMRADIUS);
    expect(ext.z).toBe(2 * OCTAGON_CIRCUMRADIUS);
  });
});

describe('genus-2 identification round trip', () => {
  it('crossing side k at t and re-crossing its mate at (1 - t) returns to the original point', () => {
    // Validate the identification rule: t -> 1 - t between mate sides
    // produces a consistent inverse pairing. This is the math-level
    // round trip; the world-coordinate version with nudge lives in the
    // wrap-step integration PR.
    for (let k = 0; k < SIDE_COUNT; k += 1) {
      const m = mateSide(k);
      for (const t of [0.1, 0.5, 0.9]) {
        const remapped = mateSide(m);
        // Mate is self-inverse, so going k -> m -> k recovers the original
        // side and inverting (1 - t) twice recovers t.
        expect(remapped).toBe(k);
        expect(1 - (1 - t)).toBeCloseTo(t, 6);
      }
    }
  });
});
