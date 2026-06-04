extends RefCounted

## Scored decision layer for the offline bot brain. Mirrors
## backend/room/src/botDecision.ts: resolves the engaged enemy (with retarget
## hysteresis and an investigate-last-known-position grace), derives the action
## flags, and picks one movement mode by argmax over scored candidates.
##
## `engagement` is a Dictionary mutated in place across ticks:
##   {engaged_target_id: String, last_known_pos: Vector3|null, investigate_until: float(ms)}
## `params`: {vision_radius, shoot_range, retarget_hysteresis, investigate_ms}.
## Players are the dicts bot_perception.gd consumes; `now` is ms.

const BotPerception := preload("res://scripts/bot_perception.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")

static func new_engagement() -> Dictionary:
	return {"engaged_target_id": "", "last_known_pos": null, "investigate_until": 0.0}

static func decide(
	bot: Dictionary,
	players: Array,
	walls: Array,
	topology: TopologyScript,
	now: float,
	active_turn_team: String,
	engagement: Dictionary,
	params: Dictionary,
	collect_target = null,
	rescue_claim = null,
	has_rescue_claim: bool = false
) -> Dictionary:
	var vision: float = params.vision_radius
	var candidate := BotPerception.best_visible_enemy(bot, players, walls, topology, now)
	var candidate_dist: float = (
		topology.distance(bot.position, candidate.position) if not candidate.is_empty() else INF
	)

	var target := candidate
	var enemy_dist: float = candidate_dist

	if engagement.engaged_target_id != "":
		var existing := _find_by_id(players, engagement.engaged_target_id)
		# A target that cloaks vanishes from perception entirely: dropped
		# outright, with none of the investigate reaction a wall occlusion gets.
		var ok: bool = (
			not existing.is_empty()
			and not existing.get("frozen", false)
			and existing.team != bot.team
			and not BotPerception.is_cloaked(existing, now)
		)
		if ok:
			var existing_visible: bool = BotPerception.bot_can_see(walls, bot.position, existing.position)
			var existing_dist: float = topology.distance(bot.position, existing.position)
			if (
				existing_visible
				and existing_dist < vision
				and candidate_dist >= existing_dist * float(params.retarget_hysteresis)
			):
				# Stay locked unless a new enemy is meaningfully closer.
				target = existing
				enemy_dist = existing_dist
			elif not existing_visible and existing_dist < vision:
				if active_turn_team == bot.team:
					# On our turn, remember where they were and go look.
					if engagement.last_known_pos == null:
						engagement.last_known_pos = existing.position
						engagement.investigate_until = now + float(params.investigate_ms)
				else:
					_clear(engagement)
		else:
			_clear(engagement)

	if not target.is_empty():
		engagement.engaged_target_id = target.id
		engagement.last_known_pos = target.position
		engagement.investigate_until = 0.0
	elif engagement.investigate_until > 0.0 and now >= engagement.investigate_until:
		_clear(engagement)

	var investigating: bool = (
		target.is_empty()
		and engagement.last_known_pos != null
		and now < engagement.investigate_until
	)

	# Rescue target: with no coordination claim provided, fall back to the solo
	# nearest-frozen-ally scan; with a claim, honor it (null = suppress rescue so
	# two bots don't swarm one ally). Mirrors botDecision's rescueOverride.
	var rescue: Dictionary
	if not has_rescue_claim:
		rescue = BotPerception.nearest_frozen_ally(bot, players, topology, vision)
	elif rescue_claim == null:
		rescue = {"target": {}, "dist": INF}
	else:
		rescue = rescue_claim

	var enemy_in_range: bool = not target.is_empty() and enemy_dist < vision
	var chasing: bool = enemy_in_range and active_turn_team == bot.team
	var fleeing: bool = enemy_in_range and active_turn_team != "" and active_turn_team != bot.team
	var rescuing: bool = not rescue.target.is_empty()
	var can_shoot: bool = (
		chasing
		and enemy_dist <= float(params.shoot_range)
		and BotPerception.bot_can_see(walls, bot.position, target.position)
	)
	var collecting: bool = collect_target != null

	return {
		"mode": _choose_mode(fleeing, rescuing, chasing, investigating, collecting),
		"target": target,
		"enemy_dist": enemy_dist,
		"rescue_target": rescue.target,
		"rescue_dist": rescue.dist,
		"collect_target": collect_target,
		"chasing": chasing,
		"fleeing": fleeing,
		"rescuing": rescuing,
		"investigating": investigating,
		"can_shoot": can_shoot,
	}

static func _choose_mode(
	fleeing: bool, rescuing: bool, chasing: bool, investigating: bool, collecting: bool
) -> String:
	# Encodes the fixed priority: flee > rescue > chase > investigate > collect
	# > patrol. Scored so later work can drop candidates into the same argmax.
	var scores := [
		["flee", 100.0 if fleeing else -INF],
		["rescue", 80.0 if rescuing else -INF],
		["chase", 60.0 if chasing else -INF],
		["investigate", 40.0 if investigating else -INF],
		["collect", 20.0 if collecting else -INF],
		["patrol", 1.0],
	]
	var best: Array = scores[0]
	for s in scores:
		if s[1] > best[1]:
			best = s
	return best[0]

static func _find_by_id(players: Array, id: String) -> Dictionary:
	for p in players:
		if p.id == id:
			return p
	return {}

static func _clear(e: Dictionary) -> void:
	e.engaged_target_id = ""
	e.last_known_pos = null
	e.investigate_until = 0.0
