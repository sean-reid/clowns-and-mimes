extends RefCounted

## Smart flee-target selection for the offline bot brain. Mirrors
## backend/room/src/botFlee.ts. Scores a fan of escape points (anchored on the
## straight-away direction) and picks the one farthest from the nearest enemy
## after dead-end + blocked-direction penalties, so a fleeing bot doesn't bolt
## into a wall or toward a second enemy. On open ground the straight-away point
## still wins. `enemies` is an Array of Vector3 enemy positions to avoid.

const TopologyScript := preload("res://scripts/topology/topology.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")
const BotPerception := preload("res://scripts/bot_perception.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")

# Quantize like bot_pathfinder (1e4) so cos/sin/sqrt noise can't flip the argmax
# on a symmetric tie; equal quantized scores keep the earlier-angle candidate.
static func _q(score: float) -> float:
	return roundf(score * 1e4) / 1e4

static func best_flee_target(
	bot_pos: Vector3,
	threat_pos: Vector3,
	enemies: Array,
	walls: Array,
	topology: TopologyScript,
	projection: float
) -> Vector3:
	# Anchor angle from the raw wrapped delta (atan2 is scale-invariant), matching
	# the TS side without a normalization step that could drift.
	var d: Vector3 = topology.delta(threat_pos, bot_pos)
	var base_angle: float = 0.0 if (d.x == 0.0 and d.z == 0.0) else atan2(d.z, d.x)
	var k: int = int(SharedConstants.BOT_FLEE_CANDIDATES)
	var best := Vector3.ZERO
	var best_score := -INF
	var have_best := false
	for i in k:
		var ang: float = base_angle + (float(i) * TAU) / float(k)
		var candidate: Vector3 = topology.wrap(
			bot_pos + Vector3(cos(ang) * projection, 0.0, sin(ang) * projection)
		)
		var nearest := INF
		for e in enemies:
			var de: float = topology.distance(candidate, e)
			if de < nearest:
				nearest = de
		if nearest == INF:
			nearest = projection
		var dead_end: float = BotPerception._corneredness(
			candidate, walls, SharedConstants.BOT_TARGET_CORNER_SAMPLE_DIST
		)
		var blocked: float = (
			1.0
			if WallGeometry.path_crosses_wall(walls, bot_pos.x, bot_pos.z, candidate.x, candidate.z)
			else 0.0
		)
		var score: float = _q(
			nearest
			- SharedConstants.BOT_FLEE_WALL_PENALTY * dead_end
			- SharedConstants.BOT_FLEE_BLOCKED_PENALTY * blocked
		)
		if score > best_score:
			best_score = score
			best = candidate
			have_best = true
	if have_best:
		return best
	return topology.wrap(
		bot_pos + Vector3(cos(base_angle) * projection, 0.0, sin(base_angle) * projection)
	)
