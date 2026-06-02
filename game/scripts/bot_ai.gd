extends Node

## Simple state machine that drives a bot Player by setting its bot_intent and
## bot_sprint each tick. Decisions are recomputed at TICK_HZ so CPU cost stays
## low even with many bots. Targets are picked using the shared game rules
## state, so the bot is topology-aware and always reasons about the same
## positions the server does.

const SharedConstants := preload("res://scripts/shared_constants.gd")

const TICK_HZ := 5.0
const TICK_PERIOD := 1.0 / TICK_HZ
const CLOSE_RADIUS := 1.4
const STUCK_SPEED := 0.5
const STUCK_TIME := 1.0
# Bot tuning is shared with the server via @cm/shared/botTuning -> SharedConstants
# (single source of truth; no hand-copied drift). Jump triggers work in seconds
# offline, derived from the canonical ms values.
const TAG_RADIUS_BOT := SharedConstants.TAG_RADIUS_BOT
const BOT_JUMP_EVADE_BUFFER := SharedConstants.BOT_JUMP_EVADE_BUFFER
const BOT_JUMP_CORNER_THREAT_RADIUS := SharedConstants.BOT_JUMP_CORNER_THREAT_RADIUS
const BOT_JUMP_NOISE_PER_SECOND := SharedConstants.BOT_JUMP_NOISE_PER_SECOND
const BOT_JUMP_REFRACTORY_S := SharedConstants.BOT_JUMP_REFRACTORY_MS / 1000.0
const BOT_NO_PROGRESS_WINDOW_S := SharedConstants.BOT_NO_PROGRESS_WINDOW_MS / 1000.0
const TopologyScript := preload("res://scripts/topology/topology.gd")
const GameRulesScript := preload("res://scripts/game_rules.gd")
const PhysicsScript := preload("res://scripts/physics.gd")
const BotPathfinderScript := preload("res://scripts/bot_pathfinder.gd")
const BotDecisionScript := preload("res://scripts/bot_decision.gd")
const BotGoalsScript := preload("res://scripts/bot_goals.gd")

enum State { PATROL, CHASE, FLEE, RESCUE, INVESTIGATE, COLLECT }

@export var player_id: String = ""

var player: CharacterBody3D
var rules: Node = null
var topology: TopologyScript
var labyrinth: Node3D = null
var rng := RandomNumberGenerator.new()

var state: int = State.PATROL
var accumulated: float = 0.0
var patrol_target: Vector3 = Vector3.ZERO
var stuck_clock: float = 0.0
var last_position: Vector3 = Vector3.ZERO
# Weighted-A* pathfinder shared with the server (built from the maze walls in
# attach). Null when there's no labyrinth, in which case the bot steers
# straight at its target.
var pathfinder: RefCounted = null
# Engagement state the decision layer carries across ticks (engaged target,
# last-known position, investigate deadline). Mutated in place by BotDecision.
var engagement: Dictionary = BotDecisionScript.new_engagement()
# The most recent decision result, computed in _choose_state and consumed by
# _choose_target the same tick.
var _decision: Dictionary = {}
# Seconds since this bot last triggered a jump. Initialised to a value
# well past the refractory window so the very first eligible tick can
# jump if the trigger fires.
var time_since_last_jump: float = 100.0

func _ready() -> void:
	rng.randomize()
	if player == null:
		player = get_parent() as CharacterBody3D
	last_position = player.global_position if player != null else Vector3.ZERO
	_pick_patrol_target()

func attach(p: CharacterBody3D, id: String, rules_ref: Node, top: TopologyScript, lab: Node3D = null) -> void:
	player = p
	player_id = id
	rules = rules_ref
	topology = top
	labyrinth = lab
	if lab != null:
		pathfinder = BotPathfinderScript.new(lab.wall_endpoints(), top.name())

func _physics_process(delta: float) -> void:
	if player == null or rules == null:
		return
	if player.frozen:
		player.bot_intent = Vector3.ZERO
		player.bot_sprint = false
		return
	accumulated += delta
	time_since_last_jump += delta
	_update_stuck(delta)
	if accumulated >= TICK_PERIOD:
		accumulated = 0.0
		_choose_state()
		_choose_target()
		_maybe_shoot()
	_drive()
	_maybe_jump(delta)

# Fire when the decision says we have a clear shot (own turn, visible enemy in
# range). offline_mode gates turn/cooldown; here we just aim. Mirrors the
# server's botShoot: planar aim at the target plus a little random spread.
func _maybe_shoot() -> void:
	if not _decision.get("can_shoot", false):
		return
	var target: Dictionary = _decision.get("target", {})
	if target.is_empty() or player == null or player.arena == null or player.arena.offline == null:
		return
	var aim: Vector3 = topology.delta(player.global_position, target.position)
	aim.y = 0.0
	if aim.length() < 0.001:
		return
	var jitter := rng.randf_range(
		-SharedConstants.BOT_SHOOT_AIM_JITTER, SharedConstants.BOT_SHOOT_AIM_JITTER
	)
	player.arena.offline.bot_shoot(player_id, aim.normalized().rotated(Vector3.UP, jitter))

func _update_stuck(delta: float) -> void:
	var moved: float = (player.global_position - last_position).length()
	if moved < STUCK_SPEED * delta:
		stuck_clock += delta
	else:
		stuck_clock = 0.0
	last_position = player.global_position

# Run the shared scored decision and map its mode to the offline State enum.
func _choose_state() -> void:
	_decision = _run_decision()
	match _decision.get("mode", "patrol"):
		"chase":
			state = State.CHASE
		"flee":
			state = State.FLEE
		"rescue":
			state = State.RESCUE
		"investigate":
			state = State.INVESTIGATE
		"collect":
			state = State.COLLECT
		_:
			state = State.PATROL

func _run_decision() -> Dictionary:
	var bot: Dictionary = rules.players.get(player_id, {})
	if bot.is_empty():
		return {}
	var walls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
	var params := {
		"vision_radius": SharedConstants.BOT_VISION_RADIUS,
		"shoot_range": SharedConstants.BOT_SHOOT_RANGE,
		"retarget_hysteresis": SharedConstants.RETARGET_HYSTERESIS,
		"investigate_ms": SharedConstants.BOT_INVESTIGATE_MS,
	}
	return BotDecisionScript.decide(
		bot,
		rules.players.values(),
		walls,
		topology,
		float(Time.get_ticks_msec()),
		rules.active_team(),
		engagement,
		params,
		_collect_target(bot)
	)

# Nearest reachable floor item, but only while empty-handed (a held item blocks
# pickup). Fed to the decision layer's opportunistic 'collect' mode. Null when
# holding an item, when there's no offline item system, or when none is close.
func _collect_target(bot: Dictionary):
	if bot.get("active_item", "") != "":
		return null
	if player == null or player.arena == null or player.arena.offline == null:
		return null
	return BotGoalsScript.nearest_item_target(
		bot.position,
		player.arena.offline.available_items(),
		topology,
		SharedConstants.BOT_ITEM_SEEK_RADIUS
	)

func _choose_target() -> void:
	match state:
		State.CHASE:
			patrol_target = _decision.target.position
		State.FLEE:
			var threat: Vector3 = _decision.target.position
			# Wrap-aware away vector (from threat toward us), projected out.
			var away: Vector3 = topology.delta(threat, player.global_position)
			away.y = 0.0
			if away.length() < 0.001:
				away = Vector3(rng.randf_range(-1.0, 1.0), 0.0, rng.randf_range(-1.0, 1.0))
			patrol_target = topology.wrap(
				player.global_position + away.normalized() * SharedConstants.BOT_FLEE_PROJECTION
			)
		State.RESCUE:
			patrol_target = _decision.rescue_target.position
		State.COLLECT:
			# Walk onto the floor item; pickup is proximity-based in offline_items.
			patrol_target = _decision.collect_target
		State.INVESTIGATE:
			patrol_target = engagement.last_known_pos
		State.PATROL:
			if patrol_target == Vector3.ZERO or (player.global_position - patrol_target).length() < 1.5:
				_pick_patrol_target()
	if stuck_clock > STUCK_TIME:
		_pick_patrol_target()
		stuck_clock = 0.0

# Cells holding other players, as a set the pathfinder soft-avoids so bots
# spread out and route around each other. The current target is exempted so the
# bot still closes on it (the pathfinder also never penalizes the goal cell).
func _occupied_cells(preserve_id: String) -> Dictionary:
	var out: Dictionary = {}
	if pathfinder == null:
		return out
	for pid in rules.players:
		if pid == player_id or pid == preserve_id:
			continue
		var pos: Vector3 = rules.players[pid].get("position", Vector3.ZERO)
		out[pathfinder.cell_at(pos)] = true
	return out

func _drive() -> void:
	if topology == null:
		player.bot_intent = Vector3.ZERO
		return
	# Ask the shared A* pathfinder for the next waypoint toward patrol_target,
	# routing around other players; physics (move_and_slide) handles the actual
	# wall sliding. Falls back to steering straight when there's no labyrinth.
	var target: Vector3 = patrol_target
	if pathfinder != null:
		var preserve_id: String = ""
		if state == State.CHASE:
			preserve_id = _nearest_enemy_id()
		elif state == State.RESCUE:
			preserve_id = _nearest_frozen_teammate_id()
		target = pathfinder.next_waypoint_avoiding(
			player.global_position, patrol_target, _occupied_cells(preserve_id)
		)
	var to_target: Vector3 = topology.delta(player.global_position, target)
	to_target.y = 0.0
	if to_target.length() < 0.05:
		player.bot_intent = Vector3.ZERO
		return
	player.bot_intent = to_target.normalized()
	player.bot_sprint = (state == State.CHASE or state == State.FLEE) and player.sprint_energy > 25.0
	if state == State.CHASE:
		_try_close_tag()
	elif state == State.RESCUE:
		_try_close_unfreeze()

func _try_close_tag() -> void:
	var enemy_id: String = _nearest_enemy_id()
	if enemy_id == "" or rules.active_team() != _team():
		return
	if _dist_to_id(enemy_id) <= CLOSE_RADIUS:
		rules.try_tag(player_id, enemy_id)

func _try_close_unfreeze() -> void:
	var teammate_id: String = _nearest_frozen_teammate_id()
	if teammate_id == "":
		return
	if _dist_to_id(teammate_id) <= CLOSE_RADIUS:
		rules.try_unfreeze(player_id, teammate_id)

# Three-trigger jump predicate that mirrors the server's botJumpDecision in
# backend/room/src/room.ts: tag-threat evasion when an active-turn opponent
# is within tag range plus a buffer, decornering when the stuck timer has
# tripped near an opponent, and a low-probability tactical-noise jump
# during an active chase. Cooldown is enforced via time_since_last_jump
# AND by skipping the eval entirely while the body is mid-arc (the
# Physics.step_jump call inside _apply_bot_movement would reject the
# request anyway, but bailing here keeps the predicate clean).
func _maybe_jump(delta: float) -> void:
	if player.jump_started_at_ms >= 0:
		return
	if time_since_last_jump < BOT_JUMP_REFRACTORY_S:
		return
	var active_team: String = rules.active_team()
	var enemy_id: String = _nearest_enemy_id()
	var enemy_dist: float = _dist_to_id(enemy_id)
	var fleeing: bool = state == State.FLEE
	var chasing: bool = state == State.CHASE
	var want_jump: bool = false
	# 1. Tag-threat evasion. Run only when this bot is defending against
	#    an active-turn opponent within reach. Skipping when the threat is
	#    already airborne avoids both bodies dancing in sync (which would
	#    still tag per Option A) and keeps the evasion legible.
	if fleeing and enemy_id != "":
		var threat: Dictionary = rules.players.get(enemy_id, {})
		var threat_pos: Vector3 = threat.get("position", Vector3.ZERO)
		# rules.update_position copies the body's Y verbatim each frame, so
		# a Y meaningfully above hover means the threat is mid-arc. Avoids
		# needing a separate jump_started_at signal in the rules dictionary.
		var threat_jumping: bool = threat_pos.y > PhysicsScript.HOVER_HEIGHT + 0.05
		if (
			not threat.get("frozen", false)
			and not threat_jumping
			and enemy_dist <= TAG_RADIUS_BOT + BOT_JUMP_EVADE_BUFFER
		):
			want_jump = true
	# 2. Cornered. The shared stuck detector tells us the bot is grinding
	#    against geometry; if any opponent is nearby a jump repositions
	#    the bot via the bounceback that lands after the arc instead of
	#    letting them be a sitting duck.
	if not want_jump and stuck_clock >= BOT_NO_PROGRESS_WINDOW_S and enemy_dist <= BOT_JUMP_CORNER_THREAT_RADIUS:
		want_jump = true
	# 3. Tactical noise during an active chase. Scaled by delta so it
	#    stays per-second-stable at any tick rate.
	if not want_jump and chasing and active_team == _team():
		if rng.randf() < BOT_JUMP_NOISE_PER_SECOND * delta:
			want_jump = true
	if want_jump:
		player.bot_jump = true
		time_since_last_jump = 0.0

func _pick_patrol_target() -> void:
	var radius: float = rng.randf_range(8.0, 32.0)
	var angle: float = rng.randf_range(0.0, TAU)
	patrol_target = Vector3(cos(angle) * radius, 0.0, sin(angle) * radius)

func _team() -> String:
	return player.team

func _nearest_enemy_id() -> String:
	var best: String = ""
	var best_d: float = INF
	for id in rules.players.keys():
		var p: Dictionary = rules.players[id]
		if p["team"] == _team():
			continue
		if p["frozen"]:
			continue
		var d: float = _dist_to(p["position"])
		if d < best_d:
			best_d = d
			best = id
	return best

func _nearest_frozen_teammate_id() -> String:
	var best: String = ""
	var best_d: float = INF
	for id in rules.players.keys():
		var p: Dictionary = rules.players[id]
		if p["team"] != _team():
			continue
		if not p["frozen"]:
			continue
		var d: float = _dist_to(p["position"])
		if d < best_d:
			best_d = d
			best = id
	return best

func _dist_to_id(id: String) -> float:
	if id == "" or not rules.players.has(id):
		return INF
	return _dist_to(rules.players[id]["position"])

func _dist_to(p: Vector3) -> float:
	if topology == null:
		return Vector2(p.x - player.global_position.x, p.z - player.global_position.z).length()
	return topology.distance(player.global_position, p)

