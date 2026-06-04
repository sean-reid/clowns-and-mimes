extends RefCounted

## Pure perception helpers for the offline bot brain. Mirrors
## backend/room/src/botPerception.ts. Players are dicts with at least
## {id, team, position: Vector3, frozen: bool, cloak_until: float(ms)}; a bot is
## one such dict. No state mutated - each function reads the roster + world and
## returns a fact. `now` is wall-clock ms (Time.get_ticks_msec()).

const WallGeometry := preload("res://scripts/wall_geometry.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")

## Compass directions sampled to gauge corneredness. Mirrors
## botPerception.ts's CORNER_SAMPLES; kept in lockstep at 8 (not a tuning knob).
const CORNER_SAMPLES := 8

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

## Fraction (0..1) of sampled directions around a point blocked by a wall within
## sample_dist - a cheap "how boxed in" proxy. Mirrors corneredness().
static func _corneredness(pos: Vector3, walls: Array, sample_dist: float) -> float:
	if walls.is_empty():
		return 0.0
	var blocked := 0
	for k in CORNER_SAMPLES:
		var a := (float(k) / float(CORNER_SAMPLES)) * TAU
		var ex := pos.x + cos(a) * sample_dist
		var ez := pos.z + sin(a) * sample_dist
		if WallGeometry.path_crosses_wall(walls, pos.x, pos.z, ex, ez):
			blocked += 1
	return float(blocked) / float(CORNER_SAMPLES)

## How cut off an enemy is from its own (active) team. Mirrors teamIsolation();
## frozen allies don't count. 0 = teammate beside it, 1 = none within vision.
static func _team_isolation(
	enemy: Dictionary, players: Array, topology: TopologyScript, vision_radius: float
) -> float:
	var nearest := INF
	for other in players:
		if other.id == enemy.id or other.team != enemy.team:
			continue
		if other.get("frozen", false):
			continue
		var d := topology.distance(enemy.position, other.position)
		if d < nearest:
			nearest = d
	if nearest == INF:
		return 1.0
	return min(nearest / vision_radius, 1.0)

## Among visible enemies, the most catchable - mirrors best_visible_enemy().
## value = -dist + cornered*CORNER_WEIGHT + isolated*ISOLATION_WEIGHT. Reduces to
## nearest_visible_enemy in the open with symmetric teams. Returns {} for none.
static func best_visible_enemy(
	bot: Dictionary, players: Array, walls: Array, topology: TopologyScript, now: float
) -> Dictionary:
	var best: Dictionary = {}
	var best_value := -INF
	for other in players:
		if other.id == bot.id or other.team == bot.team:
			continue
		if other.get("frozen", false) or is_cloaked(other, now):
			continue
		if not bot_can_see(walls, bot.position, other.position):
			continue
		var dist := topology.distance(bot.position, other.position)
		var cornered := _corneredness(
			other.position, walls, SharedConstants.BOT_TARGET_CORNER_SAMPLE_DIST
		)
		var isolated := _team_isolation(
			other, players, topology, SharedConstants.BOT_VISION_RADIUS
		)
		var value := (
			-dist
			+ cornered * SharedConstants.BOT_TARGET_CORNER_WEIGHT
			+ isolated * SharedConstants.BOT_TARGET_ISOLATION_WEIGHT
		)
		if value > best_value:
			best_value = value
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
