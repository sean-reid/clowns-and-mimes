extends Node

## Simple state machine that drives a bot Player by setting its bot_intent and
## bot_sprint each tick. Decisions are recomputed at TICK_HZ so CPU cost stays
## low even with many bots. Targets are picked using the shared game rules
## state, so the bot is topology-aware and always reasons about the same
## positions the server does.

const TICK_HZ := 5.0
const TICK_PERIOD := 1.0 / TICK_HZ
const VISION_RADIUS := 14.0
const RESCUE_RADIUS := 22.0
const CLOSE_RADIUS := 1.4
const STUCK_SPEED := 0.5
const STUCK_TIME := 1.0
# Jump triggers. Mirror the server's bot path in backend/room/src/room.ts
# so offline bots evade tags, decorner themselves, and add tactical noise
# on the same predicates online bots use. Constants chosen to match the
# server's BOT_JUMP_* values; any change should land on both sides.
const TAG_RADIUS_BOT := 1.4
const BOT_JUMP_EVADE_BUFFER := 0.5
const BOT_JUMP_CORNER_THREAT_RADIUS := 4.0
const BOT_JUMP_NOISE_PER_SECOND := 0.05
const BOT_JUMP_REFRACTORY_S := 1.5
const BOT_NO_PROGRESS_WINDOW_S := 0.8
const TopologyScript := preload("res://scripts/topology/topology.gd")
const GameRulesScript := preload("res://scripts/game_rules.gd")
const PhysicsScript := preload("res://scripts/physics.gd")

enum State { PATROL, CHASE, FLEE, RESCUE }

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
var current_path: Array[Vector3] = []
var path_index: int = 0
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
	_drive()
	_maybe_jump(delta)

func _update_stuck(delta: float) -> void:
	var moved: float = (player.global_position - last_position).length()
	if moved < STUCK_SPEED * delta:
		stuck_clock += delta
	else:
		stuck_clock = 0.0
	last_position = player.global_position

func _choose_state() -> void:
	var active_team: String = rules.active_team()
	var enemy_id: String = _nearest_enemy_id()
	var enemy_dist: float = _dist_to_id(enemy_id)
	var frozen_teammate_id: String = _nearest_frozen_teammate_id()
	var rescue_dist: float = _dist_to_id(frozen_teammate_id)
	if frozen_teammate_id != "" and rescue_dist < RESCUE_RADIUS and active_team != _opposing_team():
		state = State.RESCUE
	elif enemy_id != "" and enemy_dist < VISION_RADIUS:
		state = State.CHASE if active_team == _team() else State.FLEE
	else:
		state = State.PATROL

func _choose_target() -> void:
	match state:
		State.CHASE:
			patrol_target = _position_of(_nearest_enemy_id())
		State.FLEE:
			var threat: Vector3 = _position_of(_nearest_enemy_id())
			var away: Vector3 = player.global_position - threat
			if away.length() < 0.001:
				away = Vector3(rng.randf_range(-1.0, 1.0), 0.0, rng.randf_range(-1.0, 1.0))
			patrol_target = player.global_position + away.normalized() * 10.0
		State.RESCUE:
			patrol_target = _position_of(_nearest_frozen_teammate_id())
		State.PATROL:
			if patrol_target == Vector3.ZERO or (player.global_position - patrol_target).length() < 1.5:
				_pick_patrol_target()
	if stuck_clock > STUCK_TIME:
		_pick_patrol_target()
		stuck_clock = 0.0
	_recompute_path()

func _recompute_path() -> void:
	if labyrinth == null:
		current_path = [patrol_target]
		path_index = 0
		return
	current_path = labyrinth.find_path(player.global_position, patrol_target)
	# get_point_path returns at least the start cell; aim past it.
	path_index = 1 if current_path.size() > 1 else 0

func _next_waypoint() -> Vector3:
	while path_index < current_path.size():
		var wp: Vector3 = current_path[path_index]
		var d: float = topology.distance(player.global_position, wp) if topology != null else Vector2(wp.x - player.global_position.x, wp.z - player.global_position.z).length()
		if d < 1.0:
			path_index += 1
			continue
		return wp
	return patrol_target

func _drive() -> void:
	if topology == null:
		player.bot_intent = Vector3.ZERO
		return
	var target: Vector3 = _next_waypoint()
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

func _opposing_team() -> String:
	return "clown" if _team() == "mime" else "mime"

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

func _position_of(id: String) -> Vector3:
	if id == "" or not rules.players.has(id):
		return Vector3.ZERO
	return rules.players[id]["position"]
