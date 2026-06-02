extends RefCounted

## Pure perception helpers for the offline bot brain. Mirrors
## backend/room/src/botPerception.ts. Players are dicts with at least
## {id, team, position: Vector3, frozen: bool, cloak_until: float(ms)}; a bot is
## one such dict. No state mutated - each function reads the roster + world and
## returns a fact. `now` is wall-clock ms (Time.get_ticks_msec()).

const WallGeometry := preload("res://scripts/wall_geometry.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")

## Hidden from perception while Cloak is active (offline has no items yet, so
## cloak_until defaults to 0 and this is always false until 6d/6e).
static func is_cloaked(p: Dictionary, now: float) -> bool:
	return p.get("cloak_until", 0.0) > now

## Line of sight: visible when no wall lies between the two points.
static func bot_can_see(walls: Array, from: Vector3, to: Vector3) -> bool:
	if walls.is_empty():
		return true
	return not WallGeometry.path_crosses_wall(walls, from.x, from.z, to.x, to.z)

## Nearest enemy with line of sight (not range-limited; caller gates on vision).
## Skips same-team, frozen, cloaked. Returns the player dict, or {} for none.
static func nearest_visible_enemy(
	bot: Dictionary, players: Array, walls: Array, topology: TopologyScript, now: float
) -> Dictionary:
	var best: Dictionary = {}
	var best_dist := INF
	for other in players:
		if other.id == bot.id or other.team == bot.team:
			continue
		if other.get("frozen", false) or is_cloaked(other, now):
			continue
		if not bot_can_see(walls, bot.position, other.position):
			continue
		var d := topology.distance(bot.position, other.position)
		if d < best_dist:
			best_dist = d
			best = other
	return best

## Nearest enemy anywhere (no LOS / range / cloak filter) - radar's view.
## Returns {"target": Dictionary, "dist": float} ({} / INF when none).
static func nearest_enemy(bot: Dictionary, players: Array, topology: TopologyScript) -> Dictionary:
	var target: Dictionary = {}
	var dist := INF
	for other in players:
		if other.id == bot.id or other.team == bot.team or other.get("frozen", false):
			continue
		var d := topology.distance(bot.position, other.position)
		if d < dist:
			dist = d
			target = other
	return {"target": target, "dist": dist}

## Nearest frozen teammate within vision_radius (no LOS requirement).
static func nearest_frozen_ally(
	bot: Dictionary, players: Array, topology: TopologyScript, vision_radius: float
) -> Dictionary:
	var target: Dictionary = {}
	var dist := INF
	for other in players:
		if other.id == bot.id or other.team != bot.team or not other.get("frozen", false):
			continue
		var d := topology.distance(bot.position, other.position)
		if d < vision_radius and d < dist:
			dist = d
			target = other
	return {"target": target, "dist": dist}
