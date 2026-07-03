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
# Patrol exploration: how the bot scatters across the arena (matches the online
# pickExplorationPatrolPoint so offline bots fan out instead of converging).
const BOT_PATROL_CANDIDATE_ATTEMPTS := int(SharedConstants.BOT_PATROL_CANDIDATE_ATTEMPTS)
const BOT_PATROL_RETARGET_MS := SharedConstants.BOT_PATROL_RETARGET_MS
# Inset from the playfield edge for patrol points (matches online's half-4).
const PATROL_MARGIN := 4.0
const TopologyScript := preload("res://scripts/topology/topology.gd")
const GameRulesScript := preload("res://scripts/game_rules.gd")
const PhysicsScript := preload("res://scripts/physics.gd")
const BotPathfinderScript := preload("res://scripts/bot_pathfinder.gd")
const BotDecisionScript := preload("res://scripts/bot_decision.gd")
const BotGoalsScript := preload("res://scripts/bot_goals.gd")
const BotItemsScript := preload("res://scripts/bot_items.gd")
const BotPerception := preload("res://scripts/bot_perception.gd")
const BotCoordinationScript := preload("res://scripts/bot_coordination.gd")
const BotExplorationScript := preload("res://scripts/bot_exploration.gd")
const BotFleeScript := preload("res://scripts/bot_flee.gd")
const BotInterceptScript := preload("res://scripts/bot_intercept.gd")
const BotProjectileThreatScript := preload("res://scripts/bot_projectile_threat.gd")
const BotLeapScript := preload("res://scripts/bot_leap.gd")
const BotTurnFlipScript := preload("res://scripts/bot_turn_flip.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")

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
# Steering computed once per tick (mirrors the online bot loop): the smoothed
# heading + sprint flag the per-frame _drive applies. last_dir carries the
# previous tick's heading for smoothDir.
var last_dir: Vector3 = Vector3.ZERO
var _intent: Vector3 = Vector3.ZERO
var _sprint: bool = false
# Facing stabilizer state (mirrors BotMind.yawTarget/yawHold): the heading the
# bot is committed to and how many ticks it holds. Keeps the rendered yaw from
# hunting; does not affect movement or aim.
var _yaw_target: float = 0.0
var _yaw_hold: int = 0
# Coverage visit grid (pathfinder cell -> last-visited ms); patrol favors stale
# cells so the bot sweeps the map instead of pacing. Mirrors online BotMind.visited.
var _visited: Dictionary = {}
# Next-retarget deadline (ms) so patrol commits on a cadence like online, not
# only on arrival.
var patrol_until_ms: float = 0.0
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
# Engaged target's velocity (units/s), derived from its move since last tick, for
# predictive aim + interception. Refreshed each tick in _choose_state.
var _target_vel: Vector3 = Vector3.ZERO
var _aim_prev_id: String = ""
var _aim_prev_pos: Vector3 = Vector3.ZERO
var _aim_prev_at: float = 0.0
# When this prey bot sees incoming enemy fire but no hunter to flee from, this
# holds the bearing (a point back along the shot's line) to flee away from; else
# null. Refreshed each tick in _choose_state, consumed by the PATROL steering.
var _fire_threat: Variant = null
# True this tick when the bot is pre-positioning for the turn flip (so the
# steering layer sprints into position rather than idling at chase/flee range).
var _flip_active: bool = false
# Seconds since this bot last triggered a jump. Initialised to a value
# well past the refractory window so the very first eligible tick can
# jump if the trigger fires.
var time_since_last_jump: float = 100.0

func _ready() -> void:
	rng.randomize()
	if player == null:
		player = get_parent() as CharacterBody3D
	last_position = player.global_position if player != null else Vector3.ZERO
	_commit_patrol_target()

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
	var ticked: bool = accumulated >= TICK_PERIOD
	if ticked:
		accumulated = 0.0
		# Record the bot's current cell so patrol favors stale ones.
		var cell: int = pathfinder.cell_at(player.global_position) if pathfinder != null else -1
		BotExplorationScript.mark_visited(_visited, cell, float(Time.get_ticks_msec()))
		_choose_state()
		_choose_target()
		_choose_steering()
		_maybe_shoot()
	# Compute the jump intent once per frame (after the tick refreshes state) and
	# reuse it: a held Leap arms the very jump it triggers, so item-use needs to
	# know the bot is about to take off.
	var want_jump: bool = _wants_jump(delta)
	if ticked:
		_maybe_use_item(want_jump)
	_drive()
	if want_jump:
		player.bot_jump = true
		time_since_last_jump = 0.0

# Fire when the decision says we have a clear shot (own turn, visible enemy in
# range). offline_mode gates turn/cooldown; here we just aim. Mirrors the
# server's botShoot: planar aim at the target plus a little random spread.
func _maybe_shoot() -> void:
	if not _decision.get("can_shoot", false):
		return
	var target: Dictionary = _decision.get("target", {})
	if target.is_empty() or player == null or player.arena == null or player.arena.offline == null:
		return
	# Lead the shot: aim where the target will be when the projectile arrives.
	var aim_point: Vector3 = BotInterceptScript.intercept_point(
		player.global_position, target.position, _target_vel, SharedConstants.PROJECTILE_SPEED, topology
	)
	var aim: Vector3 = topology.delta(player.global_position, aim_point)
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
	_sense_incoming_fire()
	_decision = _run_decision()
	_update_target_velocity()
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

# Seen incoming fire: shots only come from the active hunter, so a visible enemy
# projectile means this bot is the prey. If it can't see the hunter it can still
# see the shot; _fire_threat is set to a bearing back along the shot's line and
# the PATROL steering flees away from it. A visible enemy still wins (flee
# outranks patrol). Don't distract a bot already locked on. Mirrors the online
# fireThreat compute.
func _sense_incoming_fire() -> void:
	_fire_threat = null
	if engagement.get("engaged_target_id", "") != "":
		return
	if rules == null or player == null or player.arena == null or player.arena.offline == null:
		return
	var bot: Dictionary = rules.players.get(player_id, {})
	if bot.is_empty():
		return
	var walls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
	_fire_threat = BotProjectileThreatScript.nearest_projectile_threat(
		bot,
		player.arena.offline.live_projectiles(),
		walls,
		topology,
		SharedConstants.BOT_VISION_RADIUS,
		SharedConstants.BOT_FIRE_THREAT_LOOKBACK
	)

# Refresh _target_vel from the engaged target's move since last tick. A fresh
# target id (or no target) yields zero velocity, so the lead only applies once
# we have two samples of the same target. Mirrors the online aim-velocity derive.
func _update_target_velocity() -> void:
	_target_vel = Vector3.ZERO
	var target: Dictionary = _decision.get("target", {})
	if target.is_empty():
		_aim_prev_id = ""
		return
	var now: float = float(Time.get_ticks_msec())
	var tid: String = target.id
	var tpos: Vector3 = target.position
	if _aim_prev_id == tid and now > _aim_prev_at:
		var dt_sec: float = (now - _aim_prev_at) / 1000.0
		var d: Vector3 = topology.delta(_aim_prev_pos, tpos)
		_target_vel = Vector3(d.x / dt_sec, 0.0, d.z / dt_sec)
	_aim_prev_id = tid
	_aim_prev_pos = tpos
	_aim_prev_at = now

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
	# Team rescue claims: each bot recomputes the same global assignment (pure +
	# deterministic) and consults its own entry, so two bots never swarm one
	# frozen ally. No entry -> null -> rescue suppressed this tick.
	var claims := BotCoordinationScript.assign_rescues(
		rules.players.values(), topology, SharedConstants.BOT_VISION_RADIUS
	)
	return BotDecisionScript.decide(
		bot,
		rules.players.values(),
		walls,
		topology,
		float(Time.get_ticks_msec()),
		rules.active_team(),
		engagement,
		params,
		_collect_target(bot),
		claims.get(player_id, null),
		true
	)

# Nearest reachable floor item, but only while empty-handed (a held item blocks
# pickup). Fed to the decision layer's opportunistic 'collect' mode. Null when
# holding an item, when there's no offline item system, or when none is close.
func _collect_target(bot: Dictionary):
	if bot.get("active_item", "") != "":
		return null
	if player == null or player.arena == null or player.arena.offline == null:
		return null
	# Contest items an enemy is going for ONLY on our own turn (then the enemy is
	# prey and can't tag or shoot us). On the enemy's turn the bot is prey, so
	# denial must not pull it toward a hunter - fall back to plain nearest.
	var contest: bool = rules.active_team() == player.team
	return BotGoalsScript.nearest_item_target(
		bot.position,
		player.arena.offline.available_items(),
		topology,
		SharedConstants.BOT_ITEM_SEEK_RADIUS,
		_enemy_positions(),
		SharedConstants.BOT_ITEM_CONTEST_RADIUS if contest else 0.0,
		SharedConstants.BOT_ITEM_DENY_WEIGHT if contest else 0.0
	)

# The entry mouth of a portal this bot opened, if heading into it furthers the
# flee (BotGoals.portal_escape_target gates on side + hemisphere); else null.
func _portal_escape(away: Vector3) -> Variant:
	if player.arena == null or player.arena.offline == null:
		return null
	var portal: Variant = player.arena.offline.bot_portal_entry(player_id)
	if portal == null:
		return null
	return BotGoalsScript.portal_escape_target(
		player.global_position, away, portal.a, portal.b, topology
	)

func _choose_target() -> void:
	_flip_active = false
	match state:
		State.CHASE:
			# Drive at the assigned pincer slot while closing from range; inside
			# FLANK_RELEASE_DIST intercept where the target is heading for the tag.
			# Each bot recomputes the same global chase assignment and reads its own.
			var goal: Vector3 = BotInterceptScript.intercept_point(
				player.global_position,
				_decision.target.position,
				_target_vel,
				SharedConstants.SPRINT_SPEED,
				topology
			)
			var enemy_dist: float = _decision.get("enemy_dist", INF)
			if enemy_dist > SharedConstants.BOT_CHASE_FLANK_RELEASE_DIST:
				var walls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
				var claims := BotCoordinationScript.assign_chases(
					rules.players.values(), walls, topology, float(Time.get_ticks_msec())
				)
				var claim: Variant = claims.get(player_id, null)
				if claim != null and claim.target_id == _decision.target.id:
					goal = claim.goal
			patrol_target = goal
			# Near the turn flip, pre-position for the next role instead.
			var flip_c: Variant = _turn_flip_reposition()
			if flip_c != null:
				patrol_target = flip_c
				_flip_active = true
		State.FLEE:
			var threat: Vector3 = _decision.target.position
			# Wrap-aware away vector (from threat toward us), projected out.
			var away: Vector3 = topology.delta(threat, player.global_position)
			away.y = 0.0
			if away.length() < 0.001:
				away = Vector3(rng.randf_range(-1.0, 1.0), 0.0, rng.randf_range(-1.0, 1.0))
			away = away.normalized()
			# If this bot opened a portal, head into its own entry mouth instead
			# of the open-field flee point - that's why it spent the item.
			var mouth: Variant = _portal_escape(away)
			if mouth != null:
				patrol_target = mouth
			else:
				# Score escape directions instead of bolting straight away, so the
				# bot doesn't flee into a dead-end or toward a second enemy.
				var flee_walls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
				patrol_target = BotFleeScript.best_flee_target(
					player.global_position,
					threat,
					_enemy_positions(),
					flee_walls,
					topology,
					SharedConstants.BOT_FLEE_PROJECTION
				)
			# Near the turn flip, pre-position for the next role instead.
			var flip_f: Variant = _turn_flip_reposition()
			if flip_f != null:
				patrol_target = flip_f
				_flip_active = true
		State.RESCUE:
			patrol_target = _decision.rescue_target.position
		State.COLLECT:
			# Walk onto the floor item; pickup is proximity-based in offline_items.
			patrol_target = _decision.collect_target
		State.INVESTIGATE:
			patrol_target = engagement.last_known_pos
		State.PATROL:
			if _fire_threat != null:
				# Prey that can't see its hunter but sees its incoming fire: flee
				# away from the line of fire (same scorer as a seen-threat flee).
				var fire_walls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
				patrol_target = BotFleeScript.best_flee_target(
					player.global_position,
					_fire_threat,
					[_fire_threat],
					fire_walls,
					topology,
					SharedConstants.BOT_FLEE_PROJECTION
				)
			else:
				# Retarget on a cadence or on arrival (mirrors online's drive loop),
				# not only when we reach the point - so a bot keeps roaming.
				var now_ms: float = float(Time.get_ticks_msec())
				if (
					now_ms >= patrol_until_ms
					or (player.global_position - patrol_target).length() < 1.5
				):
					_commit_patrol_target()
					patrol_until_ms = now_ms + BOT_PATROL_RETARGET_MS
	if stuck_clock > STUCK_TIME:
		_commit_patrol_target()
		stuck_clock = 0.0

# Positions of every other player (both teams) for the pathfinder's dynamic
# player-repulsion field, so the bot routes around teammates and enemies alike.
# No target is excluded: the pathfinder never penalizes the destination cell, so
# a chase / rescue target stays reachable.
func _avoid_positions() -> Array:
	var out: Array = []
	for pid in rules.players:
		if pid == player_id:
			continue
		out.append(rules.players[pid].get("position", Vector3.ZERO))
	return out

# Per-tick steering (matches the online bot loop): pick the next waypoint, smooth
# the heading across ticks (smoothDir), and decide sprint. Done at the tick rate
# - not per frame - so DIR_SMOOTHING damps jitter the way it does online instead
# of over-damping at the frame rate.
func _choose_steering() -> void:
	if topology == null:
		_intent = Vector3.ZERO
		_sprint = false
		return
	# Next waypoint toward patrol_target, routing around other players; the
	# movement step handles wall sliding. Straight at the target with no maze.
	# While airborne from a leap, drive straight at the goal to carry over a wall;
	# otherwise route around it. (The leap-traverse trigger only fires with a wall
	# in the way, so committing straight is what gets the bot across.)
	var target: Vector3 = patrol_target
	if pathfinder != null and not player.leaping:
		target = pathfinder.next_waypoint_avoiding(
			player.global_position, patrol_target, _avoid_positions()
		)
	var to_target: Vector3 = topology.delta(player.global_position, target)
	to_target.y = 0.0
	if to_target.length() < 0.05:
		_intent = Vector3.ZERO
	else:
		var raw: Vector3 = to_target.normalized()
		# Head-on swerve: nudge to a consistent side when other players sit close
		# ahead, so converging bots pass instead of mirror-deadlocking. Skipped
		# while chasing or rescuing - those need a straight line to a specific
		# body. Mirrors botManager's pass-bias gate.
		var engaged: bool = _decision.get("chasing", false) or _decision.get("rescuing", false)
		if not engaged:
			raw = _pass_bias_dir(
				raw,
				_pass_neighbor_offsets(),
				SharedConstants.BOT_PASS_BIAS_RADIUS,
				SharedConstants.BOT_PASS_BIAS_WEIGHT,
			)
		_intent = _smooth_dir(last_dir, raw, SharedConstants.DIR_SMOOTHING)
	last_dir = _intent
	# Stabilize the rendered facing so it doesn't see-saw (jarring in the
	# frozen-spectator POV). Cosmetic only - movement uses _intent directly, and
	# aim is computed independently in _maybe_shoot. Mirrors botManager's yaw path.
	if _intent.length() > 0.0001:
		var raw_yaw: float = atan2(-_intent.x, -_intent.z)
		var stab: Dictionary = _stabilize_yaw(
			_yaw_target,
			_yaw_hold,
			raw_yaw,
			SharedConstants.YAW_DEADBAND,
			SharedConstants.YAW_REVERSAL_BREAK,
			SharedConstants.YAW_COMMIT_TICKS
		)
		_yaw_target = stab["yaw"]
		_yaw_hold = stab["hold"]
		player.bot_desired_yaw = _yaw_target
	# Sprint only when closing on an engagement within the trigger radius and
	# there's energy to spend (mirrors online's closeEnemyOrRescue gate).
	var trigger: float = SharedConstants.BOT_SPRINT_TRIGGER_RADIUS
	var ed: float = _decision.get("enemy_dist", INF)
	var rd: float = _decision.get("rescue_dist", INF)
	# Panic-sprint away when the incoming fire is close (mirrors online fireClose).
	var fire_close: bool = (
		_fire_threat != null and topology.distance(player.global_position, _fire_threat) < trigger
	)
	var close: bool = (
		(_decision.get("chasing", false) and ed < trigger)
		or (_decision.get("fleeing", false) and ed < trigger)
		or (_decision.get("rescuing", false) and rd < trigger)
	)
	_sprint = (
		(close or fire_close or _flip_active) and player.sprint_energy > SharedConstants.MAX_SPRINT * 0.15
	)

# Stabilize a bot's facing target against rapid back-and-forth. Mirrors
# botSteering.ts stabilizeYaw. The bot commits to a heading and holds it: a
# re-aim smaller than `deadband` is ignored, and once committed it holds for
# `commit_ticks` ticks against any change below `reversal_break`; a change at or
# above `reversal_break` is a genuine course change and is adopted at once.
# Returns {"yaw": committed heading, "hold": remaining hold ticks}.
func _stabilize_yaw(
	target_yaw: float,
	hold_ticks: int,
	raw_desired_yaw: float,
	deadband: float,
	reversal_break: float,
	commit_ticks: int
) -> Dictionary:
	var delta: float = raw_desired_yaw - target_yaw
	while delta > PI:
		delta -= TAU
	while delta < -PI:
		delta += TAU
	var mag: float = absf(delta)
	if mag < deadband:
		return {"yaw": target_yaw, "hold": maxi(0, hold_ticks - 1)}
	if hold_ticks > 0 and mag < reversal_break:
		return {"yaw": target_yaw, "hold": hold_ticks - 1}
	return {"yaw": raw_desired_yaw, "hold": commit_ticks}

# Exponential heading smoothing across ticks, re-normalized; zero when the
# blended heading collapses. Mirrors botSteering.ts smoothDir.
func _smooth_dir(last: Vector3, raw: Vector3, smoothing: float) -> Vector3:
	var blended := Vector3(
		last.x * smoothing + raw.x * (1.0 - smoothing),
		0.0,
		last.z * smoothing + raw.z * (1.0 - smoothing),
	)
	var l: float = blended.length()
	return blended / l if l > 1e-3 else Vector3.ZERO

# Wrap-relative offsets to every other player within the pass-bias radius, for
# the head-on swerve. Wrap-aware via topology.delta so it reads correctly across
# a seam. Mirrors botManager.passNeighborOffsets.
func _pass_neighbor_offsets() -> Array:
	var out: Array = []
	var self_pos: Vector3 = player.global_position
	for pid in rules.players:
		if pid == player_id:
			continue
		var op: Vector3 = rules.players[pid].get("position", Vector3.ZERO)
		var off: Vector3 = topology.delta(self_pos, op)
		off.y = 0.0
		var d: float = off.length()
		if d < 1e-3 or d >= SharedConstants.BOT_PASS_BIAS_RADIUS:
			continue
		out.append(off)
	return out

# Deterministic head-on avoidance ("keep right" rule). Nudges the heading toward
# the bot's right when other players sit close ahead, so converging bots pass
# instead of mirroring into a deadlock. offsets are wrap-relative. Re-normalized;
# returns dir unchanged when degenerate or nothing is in the forward cone.
# Mirrors botSteering.ts passBiasDir, including the 1e-4 quantization.
func _pass_bias_dir(dir: Vector3, offsets: Array, radius: float, weight: float) -> Vector3:
	var l: float = Vector2(dir.x, dir.z).length()
	if l < 1e-3 or offsets.is_empty():
		return dir
	var fx: float = dir.x / l
	var fz: float = dir.z / l
	# Right-hand perpendicular of the heading in the XZ plane.
	var rx: float = -fz
	var rz: float = fx
	var lateral: float = 0.0
	for off in offsets:
		var d: float = Vector2(off.x, off.z).length()
		if d < 1e-3 or d >= radius:
			continue
		# Cosine of the angle to the heading: only neighbours ahead count.
		var ahead: float = (off.x * fx + off.z * fz) / d
		if ahead <= 0.0:
			continue
		var prox: float = (radius - d) / radius
		lateral += roundf(weight * prox * ahead * 1e4) / 1e4
	if lateral == 0.0:
		return dir
	var bx: float = fx + rx * lateral
	var bz: float = fz + rz * lateral
	var blen: float = Vector2(bx, bz).length()
	if blen < 1e-3:
		return dir
	return Vector3(bx / blen, 0.0, bz / blen)

func _drive() -> void:
	player.bot_intent = _intent
	player.bot_sprint = _sprint
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
func _wants_jump(delta: float) -> bool:
	if player.jump_started_at_ms >= 0:
		return false
	if time_since_last_jump < BOT_JUMP_REFRACTORY_S:
		return false
	var active_team: String = rules.active_team()
	var enemy_id: String = _nearest_enemy_id()
	var enemy_dist: float = _dist_to_id(enemy_id)
	var fleeing: bool = state == State.FLEE
	var chasing: bool = state == State.CHASE
	var want_jump: bool = false
	# 0. Dodge incoming fire: a visible enemy shot about to hit is the most urgent
	#    reason to jump - let it pass under. Highest priority.
	if player.arena != null and player.arena.offline != null:
		var me: Dictionary = rules.players.get(player_id, {})
		if not me.is_empty():
			var dodge_walls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
			if BotProjectileThreatScript.should_dodge_projectile(
				me,
				player.arena.offline.live_projectiles(),
				dodge_walls,
				topology,
				SharedConstants.BOT_DODGE_RADIUS,
				SharedConstants.BOT_DODGE_LEAD_S
			):
				return true
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
	# 4. Leap traversal: holding a Leap, hop a wall between us and a fixed
	#    objective (chase target / frozen ally) rather than pathing around. Only
	#    a leap clears walls, so gate on holding one; the steering drives straight
	#    at the goal while airborne to carry the bot over.
	if not want_jump:
		var me: Dictionary = rules.players.get(player_id, {})
		if not me.is_empty() and me.get("active_item", "") == "leap":
			var leap_goal: Variant = null
			if state == State.CHASE and not _decision.get("target", {}).is_empty():
				leap_goal = _decision.target.position
			elif state == State.RESCUE and not _decision.get("rescue_target", {}).is_empty():
				leap_goal = _decision.rescue_target.position
			if leap_goal != null:
				var lwalls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
				if BotLeapScript.should_leap_traverse(
					player.global_position, leap_goal, lwalls, topology, SharedConstants.BOT_LEAP_REACH
				):
					want_jump = true
	return want_jump

# Decide whether to spend the held power-up this tick (item-value layer), then
# apply it offline. Mirrors botManager's per-tick decideItemUse call: a used
# Radar seeds investigate memory toward the nearest enemy the bot can't see.
func _maybe_use_item(want_jump: bool) -> void:
	if player.arena == null or player.arena.offline == null:
		return
	var bot: Dictionary = rules.players.get(player_id, {})
	if bot.is_empty():
		return
	var item: String = bot.get("active_item", "")
	if item == "":
		return
	var enemy_dist: float = _decision.get("enemy_dist", INF)
	var target: Dictionary = _decision.get("target", {})
	var has_actionable: bool = not target.is_empty() and enemy_dist < SharedConstants.BOT_VISION_RADIUS
	# Radar pings the nearest enemy anywhere (ignoring walls/cloak/range), used
	# only when the bot is blind to every actionable enemy.
	var ping: Variant = null
	if not has_actionable:
		var ne := BotPerception.nearest_enemy(bot, rules.players.values(), topology)
		if not ne.target.is_empty():
			ping = ne.target.position
	var ctx := {
		"chasing": _decision.get("chasing", false),
		"fleeing": _decision.get("fleeing", false),
		"want_jump": want_jump,
		"can_shoot": _decision.get("can_shoot", false),
		"enemy_dist": enemy_dist,
		"sprint_energy": player.sprint_energy,
		"has_actionable_enemy": has_actionable,
		"nearest_enemy_pos": ping,
	}
	var params := {
		"sprint_trigger_radius": SharedConstants.BOT_SPRINT_TRIGGER_RADIUS,
		"max_sprint": SharedConstants.MAX_SPRINT,
		"tag_radius": TAG_RADIUS_BOT,
		"jump_evade_buffer": BOT_JUMP_EVADE_BUFFER,
	}
	var decision := BotItemsScript.decide_item_use(item, ctx, params)
	if not decision.use:
		return
	player.arena.offline.bot_use_item(player_id, player)
	if decision.memory_seed != null:
		engagement.last_known_pos = decision.memory_seed
		engagement.investigate_until = float(Time.get_ticks_msec()) + SharedConstants.BOT_INVESTIGATE_MS

# Uniform random point across the playfield (mirrors online randomPatrolPoint:
# WORLD_WIDTH/2 - margin per axis). NOT a ring around the origin - that made
# every bot head for the centre and bunch up.
func _random_patrol_point() -> Vector3:
	# A random pathfinder cell center spans the whole topology grid (incl. klein's
	# double cover / mobius extents), so bots explore the full map. Falls back to
	# the canonical box before attach (no pathfinder yet).
	if pathfinder != null:
		return pathfinder.cell_center_at(rng.randi() % pathfinder.cell_count())
	var half: float = TopologyScript.WIDTH / 2.0 - PATROL_MARGIN
	return Vector3(rng.randf_range(-half, half), 0.0, rng.randf_range(-half, half))

# Sample candidates and keep the highest-scoring by coverage (least-recently-
# visited cell) + heading momentum, skipping wall-blocked ones, so the bot
# sweeps the map instead of pacing. Mirrors online pickExplorationPatrolPoint.
func _pick_exploration_patrol_point() -> Vector3:
	var walls: Array = labyrinth.wall_endpoints() if labyrinth != null else []
	var teammates := _teammate_positions()
	var now_ms := float(Time.get_ticks_msec())
	var best := _random_patrol_point()
	var best_score := -INF
	for _i in BOT_PATROL_CANDIDATE_ATTEMPTS:
		var candidate := _random_patrol_point()
		if not walls.is_empty() and WallGeometry.point_blocked_by_wall(walls, candidate.x, candidate.z):
			continue
		var cell: int = pathfinder.cell_at(candidate) if pathfinder != null else -1
		var score: float = BotExplorationScript.patrol_candidate_score(
			candidate, cell, player.global_position, last_dir, _visited,
			now_ms, SharedConstants.BOT_PATROL_VISIT_DECAY_MS,
			SharedConstants.BOT_PATROL_MOMENTUM_BONUS,
			teammates, SharedConstants.BOT_PATROL_SPREAD_RADIUS, SharedConstants.BOT_PATROL_SPREAD_WEIGHT
		)
		if score > best_score:
			best_score = score
			best = candidate
	return best

# Same-team player positions to spread patrol away from (so the team covers
# distinct regions instead of clustering). Includes the human teammate.
func _teammate_positions() -> Array:
	var out: Array = []
	# _ready picks an initial patrol target before attach() wires rules/player,
	# so guard against the un-attached state (the first pick just gets no spread).
	if rules == null or player == null:
		return out
	for pid in rules.players:
		if pid == player_id:
			continue
		var p: Dictionary = rules.players[pid]
		if p.get("team", "") == player.team:
			out.append(p.get("position", Vector3.ZERO))
	return out

# Positions of every active enemy, for smart-flee scoring (avoid fleeing toward
# a second enemy). Mirrors the online flee branch's enemy gather.
func _enemy_positions() -> Array:
	var out: Array = []
	for pid in rules.players:
		var p: Dictionary = rules.players[pid]
		if p.get("team", "") != player.team and not p.get("frozen", false):
			out.append(p.get("position", Vector3.ZERO))
	return out

# Pre-position target for the imminent turn flip (retreat if about to be prey,
# close to a safe striking ring if about to be hunter), or null. Mirrors the
# online turnFlipReposition wiring; uses the engaged enemy (_decision.target).
func _turn_flip_reposition() -> Variant:
	var target: Dictionary = _decision.get("target", {})
	if target.is_empty():
		return null
	var now_s: float = Time.get_unix_time_from_system()
	var time_to_flip_ms: float = rules.phase_time_remaining(now_s) * 1000.0
	var bot_is_hunter: bool = rules.active_team() == player.team
	return BotTurnFlipScript.turn_flip_reposition(
		player.global_position,
		target.position,
		time_to_flip_ms,
		bot_is_hunter,
		topology,
		SharedConstants.BOT_TURN_ANTICIPATE_MS,
		TAG_RADIUS_BOT,
		SharedConstants.BOT_TURN_STANDOFF_BUFFER,
		SharedConstants.SPRINT_SPEED,
		SharedConstants.BOT_FLEE_PROJECTION
	)

# Commit a fresh exploration target. Mirrors online commitPatrolTarget.
func _commit_patrol_target() -> void:
	patrol_target = _pick_exploration_patrol_point()

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

