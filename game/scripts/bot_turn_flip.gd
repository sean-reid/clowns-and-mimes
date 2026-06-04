extends RefCounted

## Turn-flip anticipation for the offline bot brain. Mirrors
## backend/room/src/botTurnFlip.ts. Near a turn flip the two roles want opposite
## positions: a hunter about to become prey opens a gap (when it can't land the
## tag in time), and a prey about to become hunter holds at a standoff ring the
## still-active hunter can't close before the flip. Returns the pre-position
## target (Vector3) or null to leave normal chase/flee alone.

const TopologyScript := preload("res://scripts/topology/topology.gd")

static func turn_flip_reposition(
	bot_pos: Vector3,
	enemy_pos: Vector3,
	time_to_flip_ms: float,
	bot_is_hunter: bool,
	topology: TopologyScript,
	anticipate_ms: float,
	tag_radius: float,
	standoff_buffer: float,
	sprint_speed: float,
	flee_projection: float
) -> Variant:
	if time_to_flip_ms <= 0.0 or time_to_flip_ms >= anticipate_ms:
		return null
	var d: Vector3 = topology.delta(enemy_pos, bot_pos)  # enemy -> bot
	d.y = 0.0
	var l: float = d.length()
	if l < 1e-4:
		return null
	var outward: Vector3 = d / l
	if bot_is_hunter:
		# About to become prey: bail only if the tag won't land in time.
		if topology.distance(bot_pos, enemy_pos) <= tag_radius:
			return null
		return topology.wrap(bot_pos + outward * flee_projection)
	# About to become hunter: hold at a ring the hunter can't close in time.
	var standoff: float = tag_radius + standoff_buffer + sprint_speed * (time_to_flip_ms / 1000.0)
	return topology.wrap(enemy_pos + outward * standoff)
