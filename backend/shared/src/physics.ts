// Vertical-axis physics constants and helpers shared between the room
// Durable Object and the Godot client. Mirrors game/scripts/physics.gd
// bit-for-bit so server simulation and client prediction agree on every
// jump arc and every vertical-overlap tag check.
//
// XZ (planar) motion lives in movement.ts; this module owns Y.

import type { Vec3 } from './protocol.ts';

// Resting Y of every player. Players hover slightly above the floor by
// design; this names the existing implicit value so jump math can be
// written relative to it.
export const HOVER_HEIGHT = 0.5;

// Peak rise above HOVER_HEIGHT during a jump. At 2.0 m the body's
// center reaches ~2.5 m at apex, giving a comfortable 0.6 m vertical
// clearance over a grounded body (separation 2.0 m vs the 1.4 m tag
// threshold) so jumping reads as a real evasion tool rather than a
// "barely scraped past" miss. Head height at peak is ~3.2 m, still
// well below the 6 m wall so jumping can't see over walls.
export const JUMP_AMP = 2.0;

// Length of a single jump arc, takeoff to landing. Short enough to feel
// responsive, long enough for the squash-and-stretch animation to read.
export const JUMP_DURATION_S = 0.6;

// Tag vertical-overlap threshold. A tag is rejected when
// |attacker.y - victim.y| >= this value. Comfortably below JUMP_AMP so
// a jumper at peak (separation = JUMP_AMP = 2.0 m) clearly evades a
// grounded attacker. Mistimed jumpers (one at peak, one at takeoff or
// landing) can still tag each other per Option A. 1.4 m is roughly the
// vertical extent of the capsule collider; using the collider's own
// reach keeps the rule physically intuitive.
export const BODY_VERTICAL_EXTENT = 1.4;

// Post-landing minimum before the next jump can trigger. Prevents
// bunny-hopping without making the rhythm feel sluggish.
export const JUMP_COOLDOWN_S = 0.1;

// Coefficient of restitution for player-player collisions when neither
// party is jumping. Light shove, body-on-body contact.
export const BOUNCE_E_GROUNDED = 0.3;

// Coefficient of restitution for player-player collisions when either
// party is jumping. Pronounced rebound; airborne bodies have less
// friction to dissipate impulse.
export const BOUNCE_E_AERIAL = 0.7;

// Coefficient of restitution for player-wall collisions. Much less
// elastic than player-player; running into a wall produces a small
// visible bump-back, not a ricochet. Applied uniformly regardless of
// jump state (walls are walls).
export const BOUNCE_E_WALL = 0.15;

/**
 * Deterministic jump arc. Returns the body's Y position given the
 * jump's start timestamp (in ms, same epoch as Date.now()) and the
 * current time in ms.
 *
 * Curve: parabola y = HOVER_HEIGHT + JUMP_AMP * 4 * t * (1 - t) where
 * t = elapsed / (JUMP_DURATION_S * 1000) clamped to [0, 1]. Peaks at
 * t = 0.5 (height = HOVER_HEIGHT + JUMP_AMP), lands at t = 1.0.
 *
 * Returns HOVER_HEIGHT for a null startedAt, an elapsed time before
 * the start, or an elapsed time past the arc window. These are all
 * the "not currently jumping" cases; the caller is expected to clear
 * `jumpStartedAt` once the window expires.
 */
export function jumpArcY(startedAtMs: number | null, nowMs: number): number {
  if (startedAtMs === null) return HOVER_HEIGHT;
  const elapsedMs = nowMs - startedAtMs;
  const durationMs = JUMP_DURATION_S * 1000;
  if (elapsedMs < 0 || elapsedMs >= durationMs) return HOVER_HEIGHT;
  const t = elapsedMs / durationMs;
  return HOVER_HEIGHT + JUMP_AMP * 4 * t * (1 - t);
}

/**
 * True if the player's jump arc is still in flight. A player whose
 * `jumpStartedAt` is set but more than `JUMP_DURATION_S` ago has
 * landed; callers should clear the field in that case.
 */
export function isJumping(state: { jumpStartedAt: number | null }, nowMs: number): boolean {
  if (state.jumpStartedAt === null) return false;
  return nowMs - state.jumpStartedAt < JUMP_DURATION_S * 1000;
}

/**
 * True if two bodies' Y positions are close enough that a tag is
 * geometrically plausible. The tag pipeline gates on this in addition
 * to the existing XZ distance check.
 */
export function verticallyOverlapping(a: { position: Vec3 }, b: { position: Vec3 }): boolean {
  return Math.abs(a.position.y - b.position.y) < BODY_VERTICAL_EXTENT;
}
