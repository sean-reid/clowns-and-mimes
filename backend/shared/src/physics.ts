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

// Vertical offset from a player's authoritative position (the body base
// the wire carries) to the first-person camera, matching the Camera3D
// local Y in game/scenes/player.tscn. Projectiles spawn from this eye
// height so a shot traces the shooter's crosshair ray instead of
// launching from the feet (where it visibly emitted below the reticle).
export const EYE_HEIGHT = 1.6;

// The visible avatar is a single floating head sphere (game/scenes/player.tscn:
// SphereMesh radius 0.35, mesh centered at local Y 1.5 above the body base).
// There is no rendered torso, so a projectile only counts as a hit when it
// touches that sphere — a shot at foot height passes harmlessly under a
// standing player. These two constants define the sphere the hit test uses.
export const HEAD_CENTER_HEIGHT = 1.5;
export const HEAD_RADIUS = 0.35;

// Peak rise above HOVER_HEIGHT during a jump. At 2.0 m the body's
// center reaches ~2.5 m at apex, giving a comfortable 0.6 m vertical
// clearance over a grounded body (separation 2.0 m vs the 1.4 m tag
// threshold) so jumping reads as a real evasion tool rather than a
// "barely scraped past" miss. Head height at peak is ~3.2 m, still
// well below the 6 m wall so jumping can't see over walls.
export const JUMP_AMP = 2.0;

// Peak rise of a Leap-boosted jump. At 7.0 m the body center reaches
// ~7.5 m at apex, clearing the 6 m wall with ~1.5 m of headroom. Because
// gravity is held constant across jump heights (see jumpDurationMs), the
// taller arc also lasts longer - ~1.12 s vs the low jump's 0.6 s - and
// spends ~0.52 s above wall height, plenty to carry a sprinting body's XZ
// across a wall. The Leap power-up arms the next jump to use this
// amplitude instead of JUMP_AMP.
export const LEAP_JUMP_AMP = 7.0;

// Height of every labyrinth wall. Owned here (the vertical axis) so the
// Y-aware wall skip in movement.ts and the client mirror read one value.
// game/scripts/labyrinth.gd uses the same 6.0 for wall mesh sizing.
export const WALL_HEIGHT = 6.0;

// Length of the low (JUMP_AMP) jump arc, takeoff to landing. Short enough
// to feel responsive, long enough for the squash-and-stretch animation to
// read. This also fixes the gravity used for every jump: taller jumps keep
// the same acceleration and stretch their duration instead (jumpDurationMs).
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
 * Duration of a jump arc of peak height `amp`, in ms. Gravity is held
 * constant across jump heights, so the duration scales with sqrt(amp):
 * a taller jump hangs longer rather than falling faster. Derived from
 * the parabola's implied gravity g = 8 * amp / D^2 - holding g fixed
 * gives D = JUMP_DURATION_S * sqrt(amp / JUMP_AMP). At amp = JUMP_AMP
 * this is exactly JUMP_DURATION_S (the low jump is unchanged); at
 * LEAP_JUMP_AMP it is ~1.12 s.
 */
export function jumpDurationMs(amp: number = JUMP_AMP): number {
  return JUMP_DURATION_S * 1000 * Math.sqrt(amp / JUMP_AMP);
}

/**
 * Deterministic jump arc. Returns the body's Y position given the
 * jump's start timestamp (in ms, same epoch as Date.now()) and the
 * current time in ms.
 *
 * Curve: parabola y = HOVER_HEIGHT + amp * 4 * t * (1 - t) where
 * t = elapsed / jumpDurationMs(amp) clamped to [0, 1]. Peaks at
 * t = 0.5 (height = HOVER_HEIGHT + amp), lands at t = 1.0. `amp`
 * defaults to JUMP_AMP; a Leap-boosted jump passes LEAP_JUMP_AMP.
 * Because the duration scales with sqrt(amp), every jump shares the
 * same gravity - a higher arc stays aloft proportionally longer.
 *
 * Returns HOVER_HEIGHT for a null startedAt, an elapsed time before
 * the start, or an elapsed time past the arc window. These are all
 * the "not currently jumping" cases; the caller is expected to clear
 * `jumpStartedAt` once the window expires.
 */
export function jumpArcY(
  startedAtMs: number | null,
  nowMs: number,
  amp: number = JUMP_AMP,
): number {
  if (startedAtMs === null) return HOVER_HEIGHT;
  const elapsedMs = nowMs - startedAtMs;
  const durationMs = jumpDurationMs(amp);
  if (elapsedMs < 0 || elapsedMs >= durationMs) return HOVER_HEIGHT;
  const t = elapsedMs / durationMs;
  return HOVER_HEIGHT + amp * 4 * t * (1 - t);
}

/**
 * True if the player's jump arc is still in flight. A player whose
 * `jumpStartedAt` is set but more than the jump's duration ago has
 * landed; callers should clear the field in that case. A Leap jump
 * (state.leaping) uses the longer leap duration.
 */
export function isJumping(
  state: { jumpStartedAt: number | null; leaping?: boolean },
  nowMs: number,
): boolean {
  if (state.jumpStartedAt === null) return false;
  return nowMs - state.jumpStartedAt < jumpDurationMs(state.leaping ? LEAP_JUMP_AMP : JUMP_AMP);
}

/**
 * True if two bodies' Y positions are close enough that a tag is
 * geometrically plausible. The tag pipeline gates on this in addition
 * to the existing XZ distance check.
 */
export function verticallyOverlapping(a: { position: Vec3 }, b: { position: Vec3 }): boolean {
  return Math.abs(a.position.y - b.position.y) < BODY_VERTICAL_EXTENT;
}
