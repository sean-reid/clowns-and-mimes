extends RefCounted

## Predictive interception for the offline bot brain. Mirrors
## backend/room/src/botIntercept.ts. Estimates where a moving target will be
## after the projectile/travel time so the caller can aim or steer at the lead
## instead of trailing the target's current position. With a zero velocity the
## prediction is the target's current position, so aim/chase are unchanged.

const TopologyScript := preload("res://scripts/topology/topology.gd")

# Refinement passes - an algorithm constant matched to botIntercept.ts, not a
# tuning knob.
const INTERCEPT_ITERATIONS := 2

static func intercept_point(
	shooter_pos: Vector3,
	target_pos: Vector3,
	target_vel: Vector3,
	speed: float,
	topology: TopologyScript
) -> Vector3:
	if speed <= 0.0:
		return Vector3(target_pos.x, 0.0, target_pos.z)
	var predicted := Vector3(target_pos.x, 0.0, target_pos.z)
	for _i in INTERCEPT_ITERATIONS:
		var t: float = topology.distance(shooter_pos, predicted) / speed
		predicted = topology.wrap(
			Vector3(target_pos.x + target_vel.x * t, 0.0, target_pos.z + target_vel.z * t)
		)
	return predicted
