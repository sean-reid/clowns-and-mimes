extends RefCounted

## Online local-player predictor extracted from arena.gd under Phase C1
## of the file-split plan. Owns the _pred_* state (prev/current XZ, tick
## start time, armed flag, jumpStartedAt) and the three methods that
## drive client-side prediction:
##
##   advance_tick(world_move, sprint, jump, now_ms)
##     One server-tick worth of motion. Called from _stream_input at
##     INPUT_TICK_HZ. Mirrors Movement.step + Physics.step_jump exactly
##     so reconcile replay agrees with the server's authoritative result.
##
##   reconcile(server_delta)
##     Snap to the server's authoritative position for the local player,
##     drop acked pending inputs, replay the rest forward through
##     Movement.step + Physics.step_jump. Re-anchors prev/tick_start
##     only when the correction exceeds CORRECTION_THRESHOLD so the
##     60 Hz no-op reconciles don't pin the render lag.
##
##   advance_local_prediction(delta)
##     Render-rate visual interpolation between consecutive tick samples.
##     Writes local_player.global_position and jump_started_at_ms.
##     Lerps Y down to HOVER_HEIGHT on a frozen-mid-jump transition.
##
## State the predictor needs from arena is supplied by the host pattern:
## the predictor stores an `arena: Node` reference set at construction
## and reads arena.local_player / arena.labyrinth / arena.topology /
## arena.pending_inputs / arena.local_sprint_energy / arena.local_sprinting
## / arena.local_player_id directly. Those fields stay on arena because
## other arena paths (HUD, snapshot apply, scene tear-down) also touch them.

const Movement := preload("res://scripts/movement.gd")
const Physics := preload("res://scripts/physics.gd")

# Re-anchor prev/tick_start only when reconcile's correction exceeds
# this many world units. Below the threshold the natural predict-tick
# cycle absorbs the drift; re-anchoring on every 60 Hz no-op reconcile
# would freeze the render lag in place.
const CORRECTION_THRESHOLD := 0.05
# A single physics tick at sprint speed travels ~0.1 m. Anything past 1 m
# means the predictor wrapped across a topology seam (or reconcile
# placed the new authoritative position far from the rendered one).
# Skip the lerp in that case so the body doesn't draw a line through
# the playfield.
const WRAP_THRESHOLD := 1.0

# Authoritative predicted XZ. advance_tick rotates prev <- current and
# writes a new current; reconcile may overwrite both based on the
# server delta.
var _pred_prev_xz: Vector2 = Vector2.ZERO
var _pred_current_xz: Vector2 = Vector2.ZERO
# Wall-clock when current was written. advance_local_prediction uses
# (now - tick_start) / INPUT_TICK_PERIOD as the lerp alpha.
var _pred_tick_start_t: float = 0.0
# False until the first snapshot lands. While false, advance_tick is a
# no-op (the server has the spawn; we'll pick it up from the snapshot
# and replay queued inputs from there).
var _pred_armed: bool = false
# Predicted jumpStartedAt (Unix ms). -1 means not in lockout.
var _pred_jump_started_at_ms: int = -1
# Leap power-up prediction. _pred_leap_armed mirrors the server's leapArmed:
# set when the local player activates a held leap, consumed when the next
# jump triggers. _pred_leaping mirrors PlayerState.leaping - true while the
# current arc is a leap, which selects LEAP_JUMP_AMP for the arc Y and skips
# wall collision while above wall height. reconcile() pulls the authoritative
# leaping flag from the server delta.
var _pred_leap_armed: bool = false
var _pred_leaping: bool = false

var arena: Node = null
# Client input cadence in seconds per tick. Set at construction; matches
# arena's INPUT_TICK_PERIOD.
var input_tick_period: float = 1.0 / 60.0

func _init(arena_ref: Node, tick_period_s: float) -> void:
	arena = arena_ref
	input_tick_period = tick_period_s

## True once the snapshot has seeded prev/current from the server's
## authoritative spawn. _stream_input gates advance_tick on this; it
## also matters to advance_local_prediction (otherwise the body would
## render at Vector2.ZERO until the first snapshot).
func is_armed() -> bool:
	return _pred_armed

func get_current_xz() -> Vector2:
	return _pred_current_xz

func get_jump_started_at_ms() -> int:
	return _pred_jump_started_at_ms

## Arm the next predicted jump as a leap. arena calls this when the local
## player activates a held leap power-up, in the same frame it sends the
## use_item message, so the prediction arms when the server's leapArmed does.
func arm_leap() -> void:
	_pred_leap_armed = true

## Seed the predictor from a snapshot. Both prev and current land on
## spawn_xz so the first render frame after arming draws at exactly
## the spawn (no synthetic lerp across an uninitialised prev). Called
## from arena._on_snapshot.
func arm(spawn_xz: Vector2, jump_started_at_ms: int) -> void:
	_pred_prev_xz = spawn_xz
	_pred_current_xz = spawn_xz
	_pred_tick_start_t = Time.get_unix_time_from_system()
	_pred_jump_started_at_ms = jump_started_at_ms
	_pred_armed = true

## Render-frame visual interpolation between consecutive tick-bound
## predictions. The authoritative XZ advances once per physics tick
## inside advance_tick; this function smooths the rendered body
## transform between those samples so a >60 Hz monitor stays fluid
## without diverging from what the server sees. Y is sampled directly
## from the jump arc helper (no parallel lerp); the frozen-mid-jump
## descent uses delta.
func advance_local_prediction(delta: float) -> void:
	if arena.local_player == null or not _pred_armed:
		return
	var alpha: float = clampf(
		(Time.get_unix_time_from_system() - _pred_tick_start_t) / input_tick_period,
		0.0,
		1.0,
	)
	# Topology wraps land prev and current on opposite ends of the
	# playfield; lerping across them would shoot the body through the
	# world.
	var rendered_xz: Vector2
	if (_pred_current_xz - _pred_prev_xz).length() > WRAP_THRESHOLD:
		rendered_xz = _pred_current_xz
	else:
		rendered_xz = _pred_prev_xz.lerp(_pred_current_xz, alpha)
	# Y is a deterministic function of jumpStartedAt + wall-clock, so
	# sample directly at render time. Frozen-mid-jump produces the one
	# exception: the server clears jumpStartedAt and snaps Y to HOVER,
	# but the local body would otherwise jump straight down in a single
	# frame. Detect that case and lerp Y at ~5 m/s instead.
	var now_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	var amp: float = Physics.LEAP_JUMP_AMP if _pred_leaping else Physics.JUMP_AMP
	var rendered_y: float = Physics.jump_arc_y(_pred_jump_started_at_ms, now_ms, amp)
	var body_y: float = rendered_y
	if _pred_jump_started_at_ms < 0:
		var current_y: float = arena.local_player.global_position.y
		if current_y - Physics.HOVER_HEIGHT > 0.1:
			body_y = maxf(Physics.HOVER_HEIGHT, current_y - 5.0 * delta)
	arena.local_player.global_position = Vector3(rendered_xz.x, body_y, rendered_xz.y)
	# Push the predicted jumpStartedAt onto the body so its
	# _apply_jump_squash runs from the same source the predictor uses.
	arena.local_player.jump_started_at_ms = _pred_jump_started_at_ms
	# Same for leaping, so player.gd's render-rate arc Y picks the leap
	# amplitude instead of recomputing a normal-height arc over it.
	arena.local_player.leaping = _pred_leaping

## Advance the authoritative predicted position by one server-tick
## worth of motion. Called once per physics tick from arena._stream_input,
## matching the cadence the server uses to apply inputs.
func advance_tick(
	world_move: Vector2,
	sprint_held: bool,
	jump_pressed: bool,
	input_now_ms: int,
) -> void:
	if arena.local_player == null or arena.labyrinth == null or arena.topology == null:
		return
	# Don't advance from uninitialized state. _stream_input can fire
	# after the WS connects but before the first snapshot arrives, at
	# which point _pred_current_xz is still Vector2.ZERO and stepping
	# from origin would pile garbage into pending_inputs.
	if not _pred_armed:
		return
	# Y-aware wall skip: a leap arc whose body center clears wall height
	# passes over walls. Uses the pre-step jumpStartedAt + leap amp so the
	# body Y matches the server's lagged Y at simulateHumans time.
	var amp: float = Physics.LEAP_JUMP_AMP if _pred_leaping else Physics.JUMP_AMP
	var body_y: float = Physics.jump_arc_y(_pred_jump_started_at_ms, input_now_ms, amp)
	var above_walls: bool = body_y > Physics.WALL_HEIGHT
	var step := Movement.step(
		{
			"position": _pred_current_xz,
			"sprint_energy": arena.local_sprint_energy,
			"sprinting": arena.local_sprinting,
		},
		{"move": world_move, "sprint": sprint_held, "dt": input_tick_period},
		arena.labyrinth.wall_endpoints(),
		arena.topology,
		above_walls,
	)
	_pred_prev_xz = _pred_current_xz
	_pred_current_xz = step["position"]
	# Push out of overlap with any other body's rendered position. The
	# server's resolvePlayerCollisions does the same on its side; without
	# this, the local predictor advances INTO another body each tick and
	# reconcile snaps back to the server's pushed-apart position.
	_pred_current_xz = Movement.resolve_overlap(
		_pred_current_xz,
		arena._collect_other_xz_positions(),
		arena.labyrinth.wall_endpoints(),
		arena.topology,
	)
	_pred_tick_start_t = Time.get_unix_time_from_system()
	# Same step_jump the server runs. With the matching input_now_ms,
	# the predicted jumpStartedAt equals what the server will store, so
	# the arc Y matches at every render-rate sample after this point.
	var prev_jsa: int = _pred_jump_started_at_ms
	_pred_jump_started_at_ms = Physics.step_jump(
		prev_jsa,
		jump_pressed,
		input_now_ms,
	)
	# A fresh trigger consumes a banked leap; leaping clears when the arc
	# ends. Mirrors gameSimulation.simulateHumans on the server.
	var fresh_trigger: bool = _pred_jump_started_at_ms >= 0 and _pred_jump_started_at_ms != prev_jsa
	if fresh_trigger and _pred_leap_armed:
		_pred_leaping = true
		_pred_leap_armed = false
	if _pred_jump_started_at_ms < 0:
		_pred_leaping = false
	arena.local_sprint_energy = step["sprint_energy"]
	arena.local_sprinting = bool(step["sprinting"])
	var planar: float = (_pred_current_xz - _pred_prev_xz).length() / input_tick_period
	arena.local_player.set_external_motion(
		planar, arena.local_sprinting and world_move.length() > 0.0
	)

## Snap to the server's authoritative position for the local player,
## then replay every input the server has not yet acknowledged so the
## rendered position matches what we predict the server will compute
## next tick. Without this the client-only prediction and the server's
## simulateHumans drift apart whenever wall slides or wrap behaviour
## diverges, and tag distance checks fail with distances of 30+ units
## because attacker.position is stale on the server side.
func reconcile(delta: Dictionary) -> void:
	if arena.local_player == null or arena.labyrinth == null or arena.topology == null:
		return
	var ack_seq: int = int(delta.get("ackSeq", 0))
	var server_local: Dictionary = {}
	for entry in delta.get("players", []):
		if entry.get("id", "") == arena.local_player_id:
			server_local = entry
			break
	if server_local.is_empty():
		return
	var pos_dict: Dictionary = server_local.get("position", {"x": 0.0, "z": 0.0})
	var server_pos_raw := Vector2(float(pos_dict.get("x", 0.0)), float(pos_dict.get("z", 0.0)))
	# Defensive wrap: an older server build (or any future regression) that
	# leaves a position outside the canonical domain would otherwise pin
	# _pred_current_xz at an extended value forever, and the body would
	# flick between extended-rendered and canonical-wrapped each frame.
	var server_pos_wrapped: Vector3 = arena.topology.wrap(
		Vector3(server_pos_raw.x, 0.0, server_pos_raw.y)
	)
	var server_pos := Vector2(server_pos_wrapped.x, server_pos_wrapped.z)
	# Drop inputs the server has applied; replay the rest.
	while (
		arena.pending_inputs.size() > 0
		and int(arena.pending_inputs[0]["seq"]) <= ack_seq
	):
		arena.pending_inputs.pop_front()
	var server_sprint: float = float(server_local.get("sprintEnergy", arena.local_sprint_energy))
	arena.local_sprint_energy = server_sprint
	arena.local_sprinting = bool(server_local.get("sprinting", arena.local_sprinting))
	var walls: Array = arena.labyrinth.wall_endpoints()
	var replayed_pos: Vector2 = server_pos
	# Pull the server's authoritative jumpStartedAt and walk it forward
	# through the same step_jump the server runs.
	var server_jump_started: Variant = server_local.get("jumpStartedAt", null)
	var replayed_jump_started_at_ms: int = (
		int(server_jump_started) if server_jump_started != null else -1
	)
	# Snapshot other bodies' XZ once outside the loop; they don't change
	# during replay so the resolve step uses the same set every input.
	var others_xz: Array = arena._collect_other_xz_positions()
	# Leap arc estimate for the replay's Y-aware wall skip. The acked jump
	# state isn't replayed per-input arming, so use the current predicted
	# leaping as the arc-amplitude estimate; reconcile_leaping below pins
	# it to the server's authoritative flag once the loop settles.
	var replay_amp: float = Physics.LEAP_JUMP_AMP if _pred_leaping else Physics.JUMP_AMP
	for entry in arena.pending_inputs:
		var entry_now_ms: int = int(entry.get("now_ms", 0))
		var body_y: float = Physics.jump_arc_y(replayed_jump_started_at_ms, entry_now_ms, replay_amp)
		var above_walls: bool = body_y > Physics.WALL_HEIGHT
		var step := Movement.step(
			{
				"position": replayed_pos,
				"sprint_energy": arena.local_sprint_energy,
				"sprinting": arena.local_sprinting,
			},
			{
				"move": entry["world_move"],
				"sprint": entry["sprint"],
				"dt": entry["dt"],
			},
			walls,
			arena.topology,
			above_walls,
		)
		replayed_pos = step["position"]
		replayed_pos = Movement.resolve_overlap(replayed_pos, others_xz, walls, arena.topology)
		arena.local_sprint_energy = step["sprint_energy"]
		arena.local_sprinting = bool(step["sprinting"])
		replayed_jump_started_at_ms = Physics.step_jump(
			replayed_jump_started_at_ms,
			bool(entry.get("jump", false)),
			entry_now_ms,
		)
	_pred_jump_started_at_ms = replayed_jump_started_at_ms
	# Reconcile leaping against the server's authoritative flag. When the
	# replayed jump has landed it's false; when the server confirms a leap
	# it's true (and the banked arm is spent). Otherwise keep the local
	# prediction so a just-pressed leap the server hasn't processed yet
	# doesn't flicker back to a normal arc for one round-trip.
	var server_leaping: bool = bool(server_local.get("leaping", false))
	if replayed_jump_started_at_ms < 0:
		_pred_leaping = false
	elif server_leaping:
		_pred_leaping = true
		_pred_leap_armed = false
	# Only re-anchor when there is a real correction to absorb. In steady
	# state the predictor's _pred_current_xz already equals replayed_pos
	# (both sides run the same stepMovement deterministically) so reconcile
	# has nothing to correct; re-anchoring every 60 Hz no-op reconcile
	# would pin the render lag in place.
	if (replayed_pos - _pred_current_xz).length() > CORRECTION_THRESHOLD:
		_pred_prev_xz = Vector2(
			arena.local_player.global_position.x, arena.local_player.global_position.z
		)
		_pred_tick_start_t = Time.get_unix_time_from_system()
	_pred_current_xz = replayed_pos
	_pred_armed = true
