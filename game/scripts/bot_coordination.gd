extends RefCounted

## Team-coordination layer for the offline bot brain. Mirrors
## backend/room/src/botCoordination.ts: a pure pass over the roster that returns
## rescue claims the per-bot decision then consults.
##
## Left alone, every idle bot picks its own nearest frozen ally, so a cluster
## swarms one teammate while the rest stay frozen. assign_rescues matches each
## frozen teammate to a single rescuer (the closest free bot), spreading bots
## across distinct allies.

const TopologyScript := preload("res://scripts/topology/topology.gd")
const BotPerception := preload("res://scripts/bot_perception.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")

## Assign each frozen teammate to at most one bot rescuer and vice versa. Greedy
## over all (bot, frozen-ally) pairs in a total order - distance, then bot id,
## then ally id - so two bots never converge on the same ally and the result is
## independent of roster order (and of sort stability, matching the TS side).
## Returns a Dictionary bot_id -> {target: ally dict, dist: float}. Bots with no
## entry have no rescue this tick. Only frozen teammates within vision_radius
## count, matching the solo rescue scan.
static func assign_rescues(players: Array, topology: TopologyScript, vision_radius: float) -> Dictionary:
	var rescuers: Array = []
	var frozen: Array = []
	for p in players:
		if p.get("bot", false) and not p.get("frozen", false):
			rescuers.append(p)
		if p.get("frozen", false):
			frozen.append(p)

	var pairs: Array = []
	for bot in rescuers:
		for ally in frozen:
			if ally.team != bot.team:
				continue
			var d: float = topology.distance(bot.position, ally.position)
			if d < vision_radius:
				pairs.append({"bot_id": bot.id, "ally": ally, "dist": d})
	pairs.sort_custom(_pair_less)

	var claimed_bots: Dictionary = {}
	var claimed_allies: Dictionary = {}
	var out: Dictionary = {}
	for pr in pairs:
		if claimed_bots.has(pr.bot_id) or claimed_allies.has(pr.ally.id):
			continue
		out[pr.bot_id] = {"target": pr.ally, "dist": pr.dist}
		claimed_bots[pr.bot_id] = true
		claimed_allies[pr.ally.id] = true
	return out

# Total order matching botCoordination.ts: distance, then bot id, then ally id.
static func _pair_less(a: Dictionary, b: Dictionary) -> bool:
	if a.dist != b.dist:
		return a.dist < b.dist
	if a.bot_id != b.bot_id:
		return a.bot_id < b.bot_id
	return a.ally.id < b.ally.id

## Chase coordination - mirrors botCoordination.ts assignChases. Each target
## chased by two or more bots gets those bots fanned out onto a ring of radius
## flank_radius at evenly-spaced angles (pincer), instead of all driving at the
## target's exact spot. Each bot's chased target is recomputed via
## best_visible_enemy (pure over roster + walls; no engagement state threaded in)
## so a lone chaser - or a bot whose lock later diverges - just isn't claimed and
## drives straight in. Returns Dictionary bot_id -> {target_id, goal: Vector3}.
static func assign_chases(
	players: Array,
	walls: Array,
	topology: TopologyScript,
	now: float,
	vision_radius: float = SharedConstants.BOT_VISION_RADIUS,
	flank_radius: float = SharedConstants.BOT_CHASE_FLANK_RADIUS
) -> Dictionary:
	# Group bot chasers by the enemy each would engage.
	var groups: Dictionary = {}  # target_id -> {"target": Dictionary, "bots": Array}
	for bot in players:
		if not bot.get("bot", false) or bot.get("frozen", false):
			continue
		var target := BotPerception.best_visible_enemy(bot, players, walls, topology, now)
		if target.is_empty():
			continue
		if topology.distance(bot.position, target.position) >= vision_radius:
			continue
		if not groups.has(target.id):
			groups[target.id] = {"target": target, "bots": []}
		groups[target.id].bots.append(bot)

	var out: Dictionary = {}
	for tid in groups:
		var target: Dictionary = groups[tid].target
		var bots: Array = groups[tid].bots
		if bots.size() < 2:  # a lone chaser drives straight at the target
			continue
		var ranked: Array = []
		for b in bots:
			var d: Vector3 = topology.delta(target.position, b.position)
			ranked.append({"bot": b, "bearing": atan2(d.z, d.x)})
		ranked.sort_custom(_chase_rank_less)
		var base: float = ranked[0].bearing
		var k: int = ranked.size()
		for r in k:
			var slot: float = base + (float(r) * TAU) / float(k)
			var goal: Vector3 = topology.wrap(
				target.position
				+ Vector3(cos(slot) * flank_radius, 0.0, sin(slot) * flank_radius)
			)
			out[ranked[r].bot.id] = {"target_id": tid, "goal": goal}
	return out

# Bearing order, then bot id - matches assignChases's ranked sort so both engines
# anchor the ring at the same bot and assign the same slots.
static func _chase_rank_less(a: Dictionary, b: Dictionary) -> bool:
	if a.bearing != b.bearing:
		return a.bearing < b.bearing
	return a.bot.id < b.bot.id
