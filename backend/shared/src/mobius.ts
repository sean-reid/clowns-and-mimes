// Möbius strip topology rendered as a CYLINDRICAL DOUBLE COVER.
//
// The fundamental Möbius strip is a rectangle with the textbook identification
//
//     (x, z)  ~  (x + L, -z)        on the strip of width L and height W
//
// where crossing the seam comes with a z-flip. Rendering that flip live at
// the seam (jump in wall positions, camera mirror) feels jarring. Instead
// we render the orientation double cover: a cylinder of twice the strip's
// length, where the second half of the cylinder is the z-mirror of the
// first. Walking around the cylinder once visits both "sides" of the
// underlying Möbius surface. The seam becomes a pure x translation - no
// z-flip live at the wrap point - because the flip is baked into the
// geometry's z-mirror at x = 0.
//
// Concretely the playfield is x in [-MOBIUS_HALF_X, MOBIUS_HALF_X],
// z in [-MOBIUS_HALF_Z, MOBIUS_HALF_Z]. x wraps modular with period
// 2 * MOBIUS_HALF_X. z is hard-bounded (the Möbius strip has a single
// boundary loop; in the double-cover rendering the boundary becomes the
// top + bottom of the cylinder). The maze generator emits the left half
// (x < 0) as a regular DFS maze and mirrors it across z to fill the
// right half (x > 0) - that's where the Möbius "twist" lives.
//
// Identical math to the existing Klein bottle implementation, just with
// z hard-bounded instead of wrapping. Klein is the closed double cover
// (z wraps); Möbius is the open / bounded double cover.

import type { Vec2 } from './protocol.ts';

/**
 * Half-extent along x of the rendered cylinder. Total x range is 2 * Lx;
 * the underlying Möbius strip is half that long (the cylinder is the
 * orientation double cover). Sized so the cylinder length matches the
 * Klein bottle's 2W playfield, keeping the same arena scale.
 */
export const MOBIUS_HALF_X = 80;

/**
 * Half-extent along z. The strip's single boundary loop in the cylindrical
 * cover becomes the top + bottom z bounds. Total z range is 2 * Lz.
 */
export const MOBIUS_HALF_Z = 20;

export function mobiusExtents(): { x: number; z: number } {
  return { x: 2 * MOBIUS_HALF_X, z: 2 * MOBIUS_HALF_Z };
}

/**
 * True when `p` lies inside the cylinder's rendered domain. x is modular
 * so the check just keeps z in the strip; the x bounds are normalised
 * by the wrap rather than rejected.
 */
export function pointInMobius(p: Vec2): boolean {
  return p.z >= -MOBIUS_HALF_Z && p.z <= MOBIUS_HALF_Z;
}

/**
 * Step from `prev` to `next`. x wraps modular at 2 * MOBIUS_HALF_X; z is
 * a hard wall (returns `prev` unchanged if the candidate is past the
 * strip's z bounds, leaving the caller's wall-collision step to clip the
 * motion). No z-flip at the wrap - the flip is baked into the maze
 * geometry's z-mirror across x = 0, so the player sees continuous walls
 * across the seam.
 */
export function stepAcrossMobiusBoundary(prev: Vec2, next: Vec2): Vec2 {
  if (next.z > MOBIUS_HALF_Z + 1e-6 || next.z < -MOBIUS_HALF_Z - 1e-6) {
    return prev;
  }
  return { x: wrapModular(next.x, 2 * MOBIUS_HALF_X), z: next.z };
}

/**
 * Single-point recovery wrap. Interior points pass through; x is wrapped
 * modular; z is clamped to the strip.
 */
export function wrapMobiusPoint(p: Vec2): Vec2 {
  const x = wrapModular(p.x, 2 * MOBIUS_HALF_X);
  let z = p.z;
  if (z > MOBIUS_HALF_Z) z = MOBIUS_HALF_Z;
  else if (z < -MOBIUS_HALF_Z) z = -MOBIUS_HALF_Z;
  return { x, z };
}

function wrapModular(v: number, period: number): number {
  const half = period / 2;
  const w = (((v + half) % period) + period) % period;
  return w - half;
}
