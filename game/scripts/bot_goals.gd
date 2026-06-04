extends RefCounted

## Go-to-point goal selection for the offline bot brain. Mirrors
## backend/room/src/botGoals.ts: pure helpers that turn world state into a single
## destination the steering layer paths toward. They own no state and read only a
## snapshot.

const TopologyScript := preload("res://scripts/topology/topology.gd")

# Best floor item to seek within `seek_radius`, or null when none is close
# enough. The caller only seeks while holding no item (a held item blocks
# pickup). By default the nearest item; pass `enemies` (Array of Vector3) + a
# positive `deny_weight` for item denial - an item an enemy is contesting (within
# `contest_radius`) that the bot can still reach first gets the bonus, so the bot
# snatches it instead of a marginally closer uncontested one. Mirrors
# botGoals.ts nearestItemTarget. Returns a Vector3 destination (y zeroed) or null.
static func nearest_item_target(
	bot_pos: Vector3,
	items: Array,
	topology: TopologyScript,
	seek_radius: float,
	enemies: Array = [],
	contest_radius: float = 0.0,
	deny_weight: float = 0.0
) -> Variant:
	var best: Variant = null
	var best_score: float = -INF
	for item in items:
		var pos: Vector3 = item.position
		var d: float = topology.distance(bot_pos, pos)
		if d > seek_radius:
			continue
		var bonus: float = 0.0
		if deny_weight > 0.0 and contest_radius > 0.0:
			var nearest_enemy: float = INF
			for e in enemies:
				var ed: float = topology.distance(e, pos)
				if ed < nearest_enemy:
					nearest_enemy = ed
			if nearest_enemy < contest_radius and d <= nearest_enemy:
				bonus = deny_weight
		var score: float = bonus - d
		if score > best_score:
			best_score = score
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
