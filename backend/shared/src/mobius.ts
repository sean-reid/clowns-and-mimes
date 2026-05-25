// Möbius strip topology.
//
// The playfield is a rectangle [-Lx, Lx] x [-Lz, Lz] with the textbook
// one-twist identification:
//
//      (-Lx, z)  ~  (+Lx, -z)
//
// Left and right edges identify with a z-flip; top and bottom (z = +/- Lz)
// are hard walls (the strip has a single boundary loop topologically, so
// the top and bottom in our rectangle parametrisation are the only edges
// that aren't seams).
//
// Geometrically the Möbius strip's universal cover is the infinite flat
// strip R x [-Lz, Lz] - a flat subset of the Euclidean plane. Flat
// rendering is therefore exact, not an approximation: edge portals are
// pure translation + reflection and tile consistently. This is the same
// math Klein already uses on its x-seam, just without the corresponding
// z-wrap (the Möbius strip is a single-cover; Klein is a double cover
// that happens to have z wrap by virtue of the right half being the
// z-mirror of the left).

import type { Vec2 } from './protocol.ts';

/**
 * Half-extent of the Möbius strip along x. Total x range is 2 * Lx.
 * Sized to match WORLD_WIDTH so the strip's "length" matches the
 * canonical playfield x-dimension on other topologies.
 */
export const MOBIUS_HALF_X = 40;

/**
 * Half-extent along z. Total z range is 2 * Lz. The Möbius strip is
 * conventionally "long and narrow"; we use a 2:1 aspect (length:width)
 * so the twist actually shows up in gameplay rather than mapping to a
 * near-square arena.
 */
export const MOBIUS_HALF_Z = 20;

/**
 * Inward displacement clamped onto every wrap_step destination. Matches
 * WALL_CLEARANCE (= 0.6) plus a small epsilon so float-precision
 * rounding can't bring the destination back into the wall-clearance
 * band of any maze wall along the seam.
 */
const SAFE_INWARD = 0.65;

export function mobiusExtents(): { x: number; z: number } {
  return { x: 2 * MOBIUS_HALF_X, z: 2 * MOBIUS_HALF_Z };
}

/**
 * True when `p` lies inside the open rectangle. The Möbius identification
 * applies only to the x edges; the z edges are hard walls so points past
 * them are genuinely out-of-bounds (no wrap available).
 */
export function pointInMobius(p: Vec2): boolean {
  return (
    p.x >= -MOBIUS_HALF_X && p.x <= MOBIUS_HALF_X && p.z >= -MOBIUS_HALF_Z && p.z <= MOBIUS_HALF_Z
  );
}

/**
 * Step from `prev` (assumed inside the strip) to `next`. The left/right
 * seam wraps with a z-flip; the top/bottom z edges are hard walls so a
 * step past them returns `prev` (caller treats it as a blocked move).
 */
export function stepAcrossMobiusBoundary(prev: Vec2, next: Vec2): Vec2 {
  // z bounds first: top/bottom are hard. The collision system clips most
  // of these via labyrinth walls; this final guard catches anything that
  // slipped through.
  if (next.z > MOBIUS_HALF_Z + 1e-6 || next.z < -MOBIUS_HALF_Z - 1e-6) {
    return prev;
  }
  // x bounds: wrap with z-flip.
  if (next.x > MOBIUS_HALF_X) {
    const overshoot = next.x - MOBIUS_HALF_X;
    const inward = Math.max(overshoot, SAFE_INWARD);
    return {
      x: -MOBIUS_HALF_X + inward,
      z: -next.z,
    };
  }
  if (next.x < -MOBIUS_HALF_X) {
    const overshoot = -MOBIUS_HALF_X - next.x;
    const inward = Math.max(overshoot, SAFE_INWARD);
    return {
      x: MOBIUS_HALF_X - inward,
      z: -next.z,
    };
  }
  return next;
}

/**
 * Recovery wrap for a single point. Interior points pass through. A
 * point past the x edges identifies via the z-flip rule. A point past
 * the z edges (shouldn't happen in normal play) clamps to the boundary.
 */
export function wrapMobiusPoint(p: Vec2): Vec2 {
  let { x, z } = p;
  if (x > MOBIUS_HALF_X) {
    const overshoot = x - MOBIUS_HALF_X;
    x = -MOBIUS_HALF_X + Math.min(overshoot, 2 * MOBIUS_HALF_X);
    z = -z;
  } else if (x < -MOBIUS_HALF_X) {
    const overshoot = -MOBIUS_HALF_X - x;
    x = MOBIUS_HALF_X - Math.min(overshoot, 2 * MOBIUS_HALF_X);
    z = -z;
  }
  if (z > MOBIUS_HALF_Z) z = MOBIUS_HALF_Z;
  if (z < -MOBIUS_HALF_Z) z = -MOBIUS_HALF_Z;
  return { x, z };
}

/**
 * Affine transform that places the strip's interior into the region
 * outside source edge `side`. Used by the client renderer to draw an
 * edge portal showing the destination's terrain ahead of an actual
 * wrap_step crossing, so the player sees continuous geometry across
 * the seam instead of a teleport.
 *
 * `side` is 0 for the +x edge and 1 for the -x edge. The transform is
 * a pure translation along x plus a z-reflection (no rotation). Top and
 * bottom edges are hard walls so they have no portal.
 *
 * For the right edge (+x): translate the strip left by 2*MOBIUS_HALF_X
 * and mirror z. The translated copy sits at x in [Lx, 3*Lx], showing
 * the destination's geometry continuing rightward with the z-flip
 * baked in.
 */
export interface MobiusPortalTransform {
  /** Translation along x. */
  tx: number;
  /** Mirror z if true, else pass through. Always true for Möbius. */
  flipZ: boolean;
}

export const MOBIUS_PORTAL_RIGHT: MobiusPortalTransform = {
  tx: 2 * MOBIUS_HALF_X,
  flipZ: true,
};

export const MOBIUS_PORTAL_LEFT: MobiusPortalTransform = {
  tx: -2 * MOBIUS_HALF_X,
  flipZ: true,
};
