extends RefCounted
class_name Physics

## GDScript port of backend/shared/src/physics.ts. Keeps constants and
## helpers for the vertical axis (jump arc, Y position, vertical-overlap
## tag check) in lockstep with the server so client prediction and server
## simulation agree on every jump's Y at every tick.
##
## XZ planar motion lives in scripts/movement.gd; this module owns Y.
##
## Bit-shared numeric constants come from SharedConstants (generated from
## backend/shared/src/physics.ts) so a single edit ratchets both sides.
## See scripts/gen-shared-constants.mjs.

const SharedConstants := preload("res://scripts/shared_constants.gd")

# Resting Y of every player.
const HOVER_HEIGHT := SharedConstants.HOVER_HEIGHT
# Peak rise above HOVER_HEIGHT during a jump. Picked so head-at-peak
# (~3.2 m) stays well below the 6 m wall but separation from a
# grounded body (2.0 m) exceeds the 1.4 m tag overlap threshold.
const JUMP_AMP := SharedConstants.JUMP_AMP
# Peak rise of a Leap-boosted jump - clears the 6 m wall. Used in place of
# JUMP_AMP when a jump arc is flagged leaping.
const LEAP_JUMP_AMP := SharedConstants.LEAP_JUMP_AMP
# Height of every labyrinth wall. The Y-aware wall skip uses this so a body
# above it passes over walls.
const WALL_HEIGHT := SharedConstants.WALL_HEIGHT
# Length of the low (JUMP_AMP) jump arc takeoff to landing, in seconds. Also
# fixes the gravity for every jump - taller jumps keep the same acceleration
# and stretch their duration instead (see jump_duration_ms).
const JUMP_DURATION_S := SharedConstants.JUMP_DURATION_S
# Tag vertical-overlap threshold. Tag rejected when
# |attacker.y - victim.y| >= this value.
const BODY_VERTICAL_EXTENT := SharedConstants.BODY_VERTICAL_EXTENT
# Post-landing minimum before the next jump can trigger.
const JUMP_COOLDOWN_S := SharedConstants.JUMP_COOLDOWN_S
# Coefficients of restitution.
const BOUNCE_E_GROUNDED := SharedConstants.BOUNCE_E_GROUNDED
const BOUNCE_E_AERIAL := SharedConstants.BOUNCE_E_AERIAL
const BOUNCE_E_WALL := SharedConstants.BOUNCE_E_WALL

## Duration of a jump arc of peak height `amp`, in ms (float). Gravity is
## held constant across jump heights, so duration scales with sqrt(amp):
## a taller jump hangs longer rather than falling faster. At amp = JUMP_AMP
## this is exactly JUMP_DURATION_S * 1000 (low jump unchanged); at
## LEAP_JUMP_AMP it is ~1122 ms. Mirrors physics.ts::jumpDurationMs.
static func jump_duration_ms(amp: float = JUMP_AMP) -> float:
	return JUMP_DURATION_S * 1000.0 * sqrt(amp / JUMP_AMP)

## Deterministic jump arc. Returns the body's Y position given the
## jump's start timestamp (Unix ms) and the current time (Unix ms).
## Mirrors physics.ts::jumpArcY.
##
## Curve: y = HOVER_HEIGHT + amp * 4 * t * (1 - t) where
## t = elapsed_ms / jump_duration_ms(amp) clamped to [0, 1]. Peaks at
## t = 0.5, lands at t = 1.0. Because the duration scales with sqrt(amp),
## every jump shares the same gravity - a higher arc stays aloft longer.
##
## Returns HOVER_HEIGHT for a started_at_ms of -1 (the GDScript null
## sentinel for jumpStartedAt; -1 was chosen over 0 because 0 is a
## valid epoch timestamp), or an elapsed time outside [0, duration].
static func jump_arc_y(started_at_ms: int, now_ms: int, amp: float = JUMP_AMP) -> float:
	if started_at_ms < 0:
		return HOVER_HEIGHT
	var elapsed_ms: int = now_ms - started_at_ms
	var duration_ms: float = jump_duration_ms(amp)
	if elapsed_ms < 0 or float(elapsed_ms) >= duration_ms:
		return HOVER_HEIGHT
	var t: float = float(elapsed_ms) / duration_ms
	return HOVER_HEIGHT + amp * 4.0 * t * (1.0 - t)

## True if the player's jump arc is still in flight. started_at_ms of
## -1 (the null sentinel) is always false. A Leap jump (leaping=true)
## uses the longer leap duration.
static func is_jumping(started_at_ms: int, now_ms: int, leaping: bool = false) -> bool:
	if started_at_ms < 0:
		return false
	var amp: float = LEAP_JUMP_AMP if leaping else JUMP_AMP
	return float(now_ms - started_at_ms) < jump_duration_ms(amp)

## True if two bodies' Y positions are close enough that a tag is
## geometrically plausible. Tag pipeline gates on this in addition to
## the existing XZ distance check.
static func vertically_overlapping(y_a: float, y_b: float) -> bool:
	return absf(y_a - y_b) < BODY_VERTICAL_EXTENT

# Rate at which a frozen body's Y interpolates back to HOVER_HEIGHT
# after the freeze interrupts a jump mid-arc. Visual smoothing only -
# the server stops simulating Y the moment freeze is set, so the
# client picks up the descent so the body doesn't sit suspended at
# peak waiting for the next snapshot. 5 m/s is chosen so the body
# reaches the floor in well under half the freeze duration.
const FROZEN_DESCENT_RATE := 5.0

## One tick of the frozen-mid-jump descent ramp. Returns the next Y
## clamped at HOVER_HEIGHT so the body settles at the floor and stops.
## Pure function so it can be unit-tested without a scene tree.
static func step_frozen_descent(current_y: float, delta: float) -> float:
	return maxf(HOVER_HEIGHT, current_y - FROZEN_DESCENT_RATE * delta)

## Mirror of backend/shared/src/movement.ts::stepJump. Returns the new
## jumpStartedAt (-1 for null) after one tick of trigger / lockout
## processing.
##
## Lockout: jumpStartedAt stays set through the arc duration AND the
## post-landing cooldown. New triggers are gated on the value being -1.
## During the cooldown the body is already back at HOVER_HEIGHT
## (jump_arc_y returns the floor for elapsed past the arc); only the
## input gate remains active. A Leap (leaping=true) arc lasts longer, so
## its lockout is longer too.
static func step_jump(
	jump_started_at_ms: int, jump_pressed: bool, now_ms: int, leaping: bool = false
) -> int:
	var amp: float = LEAP_JUMP_AMP if leaping else JUMP_AMP
	var lockout_ms: float = jump_duration_ms(amp) + JUMP_COOLDOWN_S * 1000.0
	var next: int = jump_started_at_ms
	if next >= 0:
		var elapsed_ms: int = now_ms - next
		if float(elapsed_ms) >= lockout_ms:
			next = -1
	if jump_pressed and next < 0:
		next = now_ms
	return next
