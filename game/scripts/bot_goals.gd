extends RefCounted

## Go-to-point goal selection for the offline bot brain. Mirrors
## backend/room/src/botGoals.ts: pure helpers that turn world state into a single
## destination the steering layer paths toward. They own no state and read only a
## snapshot.

const TopologyScript := preload("res://scripts/topology/topology.gd")

# Nearest floor item within `seek_radius`, or null when none is close enough.
# The caller only seeks while holding no item (a held item blocks pickup, so
# there's no stacking). `items` are the offline_items dicts, each with a
# `position` Vector3. Returns a Vector3 destination (y zeroed) or null.
static func nearest_item_target(
	bot_pos: Vector3, items: Array, topology: TopologyScript, seek_radius: float
) -> Variant:
	var best: Variant = null
	var best_dist: float = INF
	for item in items:
		var pos: Vector3 = item.position
		var d: float = topology.distance(bot_pos, pos)
		if d <= seek_radius and d < best_dist:
			best_dist = d
			best = Vector3(pos.x, 0.0, pos.z)
	return best
