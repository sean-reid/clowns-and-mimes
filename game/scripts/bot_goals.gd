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

# Where a fleeing bot should walk to take the portal it opened, or null to
# ignore the portal this tick. `away` is the unit flee direction (away from the
# pursuer). Returns the entry mouth only when the bot is on the entry side
# (closer to entry than exit, so it won't teleport out and path back) and the
# mouth lies in the flee hemisphere (so it never doubles back toward the
# pursuer to reach it). Mirrors botGoals.ts portalEscapeTarget.
static func portal_escape_target(
	bot_pos: Vector3, away: Vector3, entry: Vector3, exit: Vector3, topology: TopologyScript
) -> Variant:
	if topology.distance(bot_pos, entry) > topology.distance(bot_pos, exit):
		return null
	var to_mouth: Vector3 = topology.delta(bot_pos, entry)
	if to_mouth.x * away.x + to_mouth.z * away.z <= 0.0:
		return null
	return Vector3(entry.x, 0.0, entry.z)
