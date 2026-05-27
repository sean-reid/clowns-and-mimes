extends RefCounted
class_name Physics

## GDScript port of backend/shared/src/physics.ts. Keeps constants and
## helpers for the vertical axis (jump arc, Y position, vertical-overlap
## tag check) in lockstep with the server so client prediction and server
## simulation agree on every jump's Y at every tick.
##
## XZ planar motion lives in scripts/movement.gd; this module owns Y.

# Resting Y of every player. Players hover slightly above the floor by
# design; this names the existing implicit value so jump math can be
# written relative to it.
const HOVER_HEIGHT := 0.5

# Peak rise above HOVER_HEIGHT during a jump. Center reaches ~2.0 m at
# apex, which clears another hovering player's body extent and stays
# well below the 6 m wall height (head ~3 m at peak, plenty of margin).
const JUMP_AMP := 1.5

# Length of a single jump arc, takeoff to landing, in seconds. Short
# enough to feel responsive, long enough for the squash-and-stretch
# animation to read.
const JUMP_DURATION_S := 0.6

# Tag vertical-overlap threshold in meters. A tag is rejected when
# |attacker.y - victim.y| >= this value. Slightly less than JUMP_AMP so
# a jumper at peak just barely evades a grounded attacker. Mistimed
# jumpers (one at peak, one at takeoff or landing) are within the
# threshold and the tag fires per Option A.
const BODY_VERTICAL_EXTENT := 1.4

# Post-landing minimum before the next jump can trigger. Prevents
# bunny-hopping without making the rhythm feel sluggish.
const JUMP_COOLDOWN_S := 0.1

# Coefficients of restitution. Match backend/shared/src/physics.ts.
const BOUNCE_E_GROUNDED := 0.3
const BOUNCE_E_AERIAL := 0.7
const BOUNCE_E_WALL := 0.15

## Deterministic jump arc. Returns the body's Y position given the
## jump's start timestamp (Unix ms) and the current time (Unix ms).
## Mirrors physics.ts::jumpArcY.
##
## Curve: y = HOVER_HEIGHT + JUMP_AMP * 4 * t * (1 - t) where
## t = elapsed_ms / (JUMP_DURATION_S * 1000) clamped to [0, 1]. Peaks
## at t = 0.5, lands at t = 1.0.
##
## Returns HOVER_HEIGHT for a started_at_ms of -1 (the GDScript null
## sentinel for jumpStartedAt; -1 was chosen over 0 because 0 is a
## valid epoch timestamp), or an elapsed time outside [0, duration].
static func jump_arc_y(started_at_ms: int, now_ms: int) -> float:
	if started_at_ms < 0:
		return HOVER_HEIGHT
	var elapsed_ms: int = now_ms - started_at_ms
	var duration_ms: int = int(JUMP_DURATION_S * 1000.0)
	if elapsed_ms < 0 or elapsed_ms >= duration_ms:
		return HOVER_HEIGHT
	var t: float = float(elapsed_ms) / float(duration_ms)
	return HOVER_HEIGHT + JUMP_AMP * 4.0 * t * (1.0 - t)

## True if the player's jump arc is still in flight. started_at_ms of
## -1 (the null sentinel) is always false.
static func is_jumping(started_at_ms: int, now_ms: int) -> bool:
	if started_at_ms < 0:
		return false
	return now_ms - started_at_ms < int(JUMP_DURATION_S * 1000.0)

## True if two bodies' Y positions are close enough that a tag is
## geometrically plausible. Tag pipeline gates on this in addition to
## the existing XZ distance check.
static func vertically_overlapping(y_a: float, y_b: float) -> bool:
	return absf(y_a - y_b) < BODY_VERTICAL_EXTENT
