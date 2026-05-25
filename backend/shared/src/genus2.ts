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
 * Minimum inward displacement applied to a wrap_step destination off
 * the receiving side, in world units. Mirrors WALL_CLEARANCE from
 * labyrinth.ts (0.6) plus a small safety margin so float-precision
 * wobble can't bring the destination back into the wall-clearance band
 * of any maze wall near the boundary. Bigger inward gives more
 * continuity room at the cost of the player visibly "jumping" further
 * into the polygon when they cross.
 */
const SAFE_INWARD = 0.65;

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

/**
 * Wrap a step from `prev` (assumed inside the octagon) to `next`. If
 * `next` is inside, returns `next` unchanged. Otherwise routes through
 * the identification: parametrize `next` along the crossed side, emerge
 * from the mate side at the inverted parameter, displaced inward by the
 * overshoot magnitude.
 *
 * When `next` crosses two sides at once (corner of the polygon), the
 * side with the largest outward distance wins. This is rare in normal
 * play because the polygon vertices all identify to a single cone point
 * the player would have to walk straight at.
 */
export function stepAcrossGenus2Boundary(prev: Vec2, next: Vec2): Vec2 {
  void prev;
  if (pointInOctagon(next)) return next;
  const sideIdx = sideOfBoundary(next);
  if (sideIdx === null) return next;
  const t = parametrizeAlongSide(next, sideIdx);
  const overshoot = signedDistanceToSide(next, sideIdx);
  const m = mateSide(sideIdx);
  const arrival = pointOnSide(m, 1 - t);
  const inw = inwardNormal(m);
  // Inward displacement clamped to at least SAFE_INWARD: the player needs
  // to land far enough off the receiving side that no maze wall near the
  // boundary catches them in its WALL_CLEARANCE band on the next tick.
  // Without the clamp the overshoot is typically ~ 0.04 world units,
  // which lands the destination exactly at the maze-cell boundary and
  // IEEE-754 rounding flips the wall check below WALL_CLEARANCE for
  // the start point of every subsequent tick.
  const inward = Math.max(overshoot, SAFE_INWARD);
  return {
    x: arrival.x + inward * inw.x,
    z: arrival.z + inward * inw.z,
  };
}

/**
 * Recovery wrap for a single point. If `p` is inside the octagon,
 * returns it unchanged. If outside (shouldn't happen in normal play
 * because every motion step routes through stepAcrossGenus2Boundary),
 * applies the identification once to bring it onto the mate side, then
 * clamps to the polygon interior in case the identified point also
 * lands outside. Final fallback is the centre.
 */
export function wrapGenus2Point(p: Vec2): Vec2 {
  if (pointInOctagon(p)) return p;
  const sideIdx = sideOfBoundary(p);
  if (sideIdx === null) return p;
  const t = parametrizeAlongSide(p, sideIdx);
  const overshoot = signedDistanceToSide(p, sideIdx);
  const m = mateSide(sideIdx);
  const arrival = pointOnSide(m, 1 - t);
  const inw = inwardNormal(m);
  const inward = Math.max(overshoot, SAFE_INWARD);
  const wrapped = {
    x: arrival.x + inward * inw.x,
    z: arrival.z + inward * inw.z,
  };
  if (pointInOctagon(wrapped)) return wrapped;
  // Doubly-exterior point (very rare). Fall back to the centre.
  return { x: 0, z: 0 };
}

/**
 * Affine transform that places the mate side's interior into the region
 * outside source side `sideIdx`. Used by the client renderer to draw an
 * edge portal showing the destination's terrain ahead of an actual
 * wrap_step crossing, so the player sees continuous geometry across the
 * seam instead of a jarring jump in wall positions.
 *
 * For each side k, the identification glues V_k to V_{m+1} and V_{k+1}
 * to V_m (where m = mateSide(k)). The orientation-preserving isometry
 * that satisfies this is a pure rotation around the origin by +90 deg
 * CCW (because all 4 mate pairs are at exactly +90 deg around the
 * regular octagon's centre) plus a translation that lines V_m up with
 * V_{k+1}.
 *
 * Returns the rotation in radians and the translation in world units.
 * The client applies these to a Node3D containing a copy of the maze
 * geometry: `position = (tx, 0, tz)`, `rotation.y = rotationRadians`.
 */
export interface PortalTransform {
  /** Rotation angle around the world Y axis in radians. */
  rotationRadians: number;
  /** Translation in world units, applied after the rotation. */
  tx: number;
  tz: number;
}

export function genus2PortalTransform(sideIdx: number): PortalTransform {
  const m = mateSide(sideIdx);
  const Vm = OCTAGON_VERTICES[m]!;
  const Vk1 = OCTAGON_VERTICES[(sideIdx + 1) % 8]!;
  // The mate is either +2 or +6 (= -2) sides away around the regular
  // octagon. Each direction has its own rotation sign because the
  // parameter-flip identification reverses orientation along the side,
  // and the rotation that takes the mate side's "interior" to the
  // source side's "exterior" depends on which direction the mate sits.
  // forward (mate = k + 2 mod 8): rotation = +90 deg CCW
  // backward (mate = k + 6 mod 8): rotation = -90 deg
  const forwardMate = (m - sideIdx + 8) % 8 === 2;
  let rotVmX: number;
  let rotVmZ: number;
  if (forwardMate) {
    // (x, z) -> (-z, x): +90 deg CCW around Y axis.
    rotVmX = -Vm.z;
    rotVmZ = Vm.x;
  } else {
    // (x, z) -> (z, -x): -90 deg around Y axis.
    rotVmX = Vm.z;
    rotVmZ = -Vm.x;
  }
  return {
    rotationRadians: forwardMate ? Math.PI / 2 : -Math.PI / 2,
    tx: Vk1.x - rotVmX,
    tz: Vk1.z - rotVmZ,
  };
}
