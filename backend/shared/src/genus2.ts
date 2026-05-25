// Genus-2 closed surface (a.k.a. double torus) rendered as a regular
// octagonal fundamental polygon with the standard side identification
//
//     a b a-1 b-1 c d c-1 d-1
//
// In the unfold, the 8 sides are labeled in cyclic order:
//
//   side index :  0  1  2     3     4  5  6     7
//   label      :  a  b  a^-1  b^-1  c  d  c^-1  d^-1
//
// Same letters glue across the polygon with the parameter reversed
// (an "inverse" side runs the opposite direction along the same identified
// curve). So side k's identification mate is `k XOR 2`:
//
//   0 <-> 2,  1 <-> 3,  4 <-> 6,  5 <-> 7
//
// Crossing side k at parameter t along it emerges from side mate(k) at
// parameter (1 - t). All 8 polygon vertices identify to a single cone
// point on the surface where the surface angle totals 8 * 135° = 1080°
// of "interior" angle (around-the-point total exceeds 360°, characteristic
// of genus-2 hyperbolic surfaces).
//
// This module owns just the geometry and identification math. The wrap
// integration (wrapPosition / wrapPositionFromStep), maze generator, and
// GDScript mirror land in follow-up PRs.

import type { Vec2 } from './protocol.ts';

/**
 * Circumradius of the fundamental octagon in world units. The polygon's
 * bounding box is [-R, R] x [-R, R] so the playfield "extent" mirrors a
 * square arena, just with the corners chopped off by the diagonal sides.
 */
export const OCTAGON_CIRCUMRADIUS = 40;

/**
 * 8 vertices on a circle of radius OCTAGON_CIRCUMRADIUS, in CCW order
 * starting at angle 0 (the rightmost vertex). Vertex k is at angle
 * 45 * k degrees. All 8 vertices identify to a single cone point on the
 * genus-2 surface.
 */
export const OCTAGON_VERTICES: Vec2[] = Array.from({ length: 8 }, (_, k) => {
  const theta = (Math.PI / 4) * k;
  return {
    x: Math.cos(theta) * OCTAGON_CIRCUMRADIUS,
    z: Math.sin(theta) * OCTAGON_CIRCUMRADIUS,
  };
});

export const SIDE_COUNT = 8;

/**
 * The 8 fundamental-polygon sides. Side k runs from vertex k to vertex
 * (k+1) mod 8. The outward normal points away from the polygon's
 * interior; the inward normal toward the centre.
 */
export interface OctagonSide {
  readonly start: Vec2;
  readonly end: Vec2;
  /**
   * Unit vector along the side from `start` to `end`. The "+t direction"
   * for parametrize / pointOnSide.
   */
  readonly tangent: Vec2;
  /**
   * Unit vector perpendicular to the side, pointing OUT of the octagon
   * (i.e., toward the half-plane the boundary excludes). Used in the
   * point-in-polygon and side-crossing tests.
   */
  readonly outwardNormal: Vec2;
  /**
   * Length of the side in world units (constant across all 8 sides for
   * a regular octagon, but stored per-side to avoid recomputation).
   */
  readonly length: number;
}

export const OCTAGON_SIDES: OctagonSide[] = OCTAGON_VERTICES.map((v0, k) => {
  const v1 = OCTAGON_VERTICES[(k + 1) % 8]!;
  const dx = v1.x - v0.x;
  const dz = v1.z - v0.z;
  const length = Math.hypot(dx, dz);
  const tangent = { x: dx / length, z: dz / length };
  // For a CCW-traversed convex polygon, the outward normal is the tangent
  // rotated -90° (i.e., (tx, tz) -> (tz, -tx)).
  const outwardNormal = { x: tangent.z, z: -tangent.x };
  return {
    start: v0,
    end: v1,
    tangent,
    outwardNormal,
    length,
  };
});

/**
 * The identification mate of side k. Same-letter sides in the
 * fundamental polygon word `aba^-1b^-1cdc^-1d^-1` are paired:
 * 0<->2, 1<->3, 4<->6, 5<->7. The relation is `mate(k) = k XOR 2`.
 */
export function mateSide(sideIdx: number): number {
  return sideIdx ^ 2;
}

/**
 * Signed perpendicular distance from `p` to side `sideIdx`. Positive when
 * `p` is on the outward (excluded) half-plane, negative when inside.
 */
export function signedDistanceToSide(p: Vec2, sideIdx: number): number {
  const s = OCTAGON_SIDES[sideIdx]!;
  return (p.x - s.start.x) * s.outwardNormal.x + (p.z - s.start.z) * s.outwardNormal.z;
}

/**
 * True when `p` lies inside (or on) the octagonal fundamental polygon.
 */
export function pointInOctagon(p: Vec2): boolean {
  for (let k = 0; k < SIDE_COUNT; k += 1) {
    if (signedDistanceToSide(p, k) > 1e-9) return false;
  }
  return true;
}

/**
 * Which side `p` crossed when it left the polygon, or null if `p` is
 * still inside. When `p` is outside on multiple sides (e.g., past a
 * vertex), returns the side with the largest outward distance.
 */
export function sideOfBoundary(p: Vec2): number | null {
  let bestSide = -1;
  let bestDist = 1e-9;
  for (let k = 0; k < SIDE_COUNT; k += 1) {
    const d = signedDistanceToSide(p, k);
    if (d > bestDist) {
      bestDist = d;
      bestSide = k;
    }
  }
  return bestSide >= 0 ? bestSide : null;
}

/**
 * Parameter t in [0, 1] of the projection of `p` onto side `sideIdx`.
 * Clamped so the result stays on the segment.
 */
export function parametrizeAlongSide(p: Vec2, sideIdx: number): number {
  const s = OCTAGON_SIDES[sideIdx]!;
  const projection = (p.x - s.start.x) * s.tangent.x + (p.z - s.start.z) * s.tangent.z;
  const t = projection / s.length;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/**
 * Point at parameter `t` along side `sideIdx`. t = 0 is `start`, t = 1
 * is `end`.
 */
export function pointOnSide(sideIdx: number, t: number): Vec2 {
  const s = OCTAGON_SIDES[sideIdx]!;
  return {
    x: s.start.x + (s.end.x - s.start.x) * t,
    z: s.start.z + (s.end.z - s.start.z) * t,
  };
}

/**
 * Inward normal of side k (negation of outwardNormal). Used by the wrap
 * integration to nudge the player slightly inside the destination side.
 */
export function inwardNormal(sideIdx: number): Vec2 {
  const o = OCTAGON_SIDES[sideIdx]!.outwardNormal;
  return { x: -o.x, z: -o.z };
}

/**
 * Playfield half-extent for the genus-2 topology. The octagon's bounding
 * box is [-R, R] x [-R, R], but most points along the diagonal sides are
 * inside the polygon. Used by the topology adapter to expose extent_x /
 * extent_z to the maze and renderer.
 */
export function genus2Extents(): { x: number; z: number } {
  return { x: 2 * OCTAGON_CIRCUMRADIUS, z: 2 * OCTAGON_CIRCUMRADIUS };
}
