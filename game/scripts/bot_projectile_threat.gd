extends RefCounted

## Incoming-fire awareness for the offline bot brain - by sight, not hearing.
## Mirrors backend/room/src/botProjectileThreat.ts. A bot reacts only to an enemy
## projectile it can see (within sight range, line of sight) and, never having
## seen the muzzle, infers only the line of fire. Returns a threat point a short
## way back along the nearest visible, approaching enemy projectile's reverse
## trajectory - a bearing to flee away from, not a claimed origin - or null.
## `projectiles` is an Array of dicts {owner_id, team, position:Vector3, velocity:Vector3}.

const TopologyScript := preload("res://scripts/topology/topology.gd")
const BotPerception := preload("res://scripts/bot_perception.gd")

static func nearest_projectile_threat(
	bot: Dictionary,
	projectiles: Array,
	walls: Array,
	topology: TopologyScript,
	sight_radius: float,
	lookback: float
) -> Variant:
	var best: Variant = null
	var best_dist := INF
	for p in projectiles:
		if p.get("owner_id", "") == bot.id or p.get("team", "") == bot.team:
			continue
		var pos: Vector3 = p.position
		var dist: float = topology.distance(bot.position, pos)
		if dist > sight_radius:
			continue
		if not BotPerception.bot_can_see(walls, bot.position, pos):
			continue
		var vel: Vector3 = p.velocity
		var vlen: float = sqrt(vel.x * vel.x + vel.z * vel.z)
		if vlen < 1e-6:
			continue
		# Only fire heading toward this bot is incoming.
		var to_bot_x: float = bot.position.x - pos.x
		var to_bot_z: float = bot.position.z - pos.z
		if vel.x * to_bot_x + vel.z * to_bot_z <= 0.0:
			continue
		if dist < best_dist:
			best_dist = dist
			var vx: float = vel.x / vlen
			var vz: float = vel.z / vlen
			best = topology.wrap(Vector3(pos.x - vx * lookback, 0.0, pos.z - vz * lookback))
	return best

## True when a visible enemy shot is about to pass close enough to hit the bot -
## the cue to jump and let it go under. Mirrors shouldDodgeProjectile.
static func should_dodge_projectile(
	bot: Dictionary,
	projectiles: Array,
	walls: Array,
	topology: TopologyScript,
	dodge_radius: float,
	lead_time_s: float
) -> bool:
	for p in projectiles:
		if p.get("owner_id", "") == bot.id or p.get("team", "") == bot.team:
			continue
		var pos: Vector3 = p.position
		if not BotPerception.bot_can_see(walls, bot.position, pos):
			continue
		var vel: Vector3 = p.velocity
		var vv: float = vel.x * vel.x + vel.z * vel.z
		if vv < 1e-9:
			continue
		var rel: Vector3 = topology.delta(bot.position, pos)
		var t_star: float = -(rel.x * vel.x + rel.z * vel.z) / vv
		if t_star <= 0.0 or t_star > lead_time_s:
			continue
		var cx: float = rel.x + vel.x * t_star
		var cz: float = rel.z + vel.z * t_star
		if sqrt(cx * cx + cz * cz) <= dodge_radius:
			return true
	return false
