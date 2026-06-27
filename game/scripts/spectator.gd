extends RefCounted

## Pure pose math for the teammate-spectator camera. Kept out of arena.gd so it
## can be unit-tested without a scene tree.
##
## While frozen, the local player can watch a teammate's first-person POV. The
## spectator camera is positioned at the teammate's eye and oriented with their
## look. The eye sits EYE_HEIGHT above the body origin - the same local offset as
## the player scene's Camera3D node - and a body rotates only on yaw, so the
## offset is yaw-independent (a Y-axis rotation leaves a point on the Y axis put).
## Pitch is the value the server carries for that body (its original camera
## pitch), so a camera set to (pitch, yaw, 0) reproduces exactly what the
## teammate sees.

const SharedConstants := preload("res://scripts/shared_constants.gd")

## World-space eye position for a body at `body_position`.
static func eye_position(body_position: Vector3) -> Vector3:
	return body_position + Vector3(0.0, SharedConstants.EYE_HEIGHT, 0.0)

## Euler rotation (radians) for a first-person camera looking with `yaw` (about
## Y) and `pitch` (about X), matching how the player's body yaw + camera pitch
## compose.
static func look_rotation(yaw: float, pitch: float) -> Vector3:
	return Vector3(pitch, yaw, 0.0)

## Whether a body is a valid spectate target for a viewer on `my_team`: a
## same-team player who isn't frozen. (The caller excludes the viewer itself by
## id; bots are eligible, so an all-bot team offline still has someone to watch.)
static func is_teammate_target(target_team: String, target_frozen: bool, my_team: String) -> bool:
	return target_team == my_team and not target_frozen

## Next index when cycling through `count` targets, wrapping around. A `current`
## of -1 (the active target isn't in the list) lands on the first entry, so a
## left-click after the watched teammate dropped out starts the cycle cleanly.
static func next_index(current: int, count: int) -> int:
	if count <= 0:
		return -1
	return (current + 1) % count
