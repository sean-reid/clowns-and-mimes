extends "res://tests/test_case.gd"

## Phase A2 of the file-split plan: scaffolding for the C1 OnlinePredictor
## extraction. Demonstrates the shape of a deterministic predictor test
## that does NOT need a scene tree.
##
## Pattern only - the predictor itself is still inlined in arena.gd. When
## C1 lands `game/scripts/online_predictor.gd` (RefCounted, no scene
## dependencies), the helpers in this file feed it canonical state and
## assert its outputs.
##
## The trio it'll test on:
##   1. advance_tick: world_move + sprint + jump -> new pred state
##   2. reconcile: server delta + pending inputs -> replayed state
##   3. render_interp: prev/current pred + alpha -> rendered XZ
##
## All three are functions of (state in, input in) -> state out. None
## need a Node3D. The mock helpers below are what makes that possible
## without re-implementing the predictor in this file.

const Movement := preload("res://scripts/movement.gd")
const Physics := preload("res://scripts/physics.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")
const OnlinePredictor := preload("res://scripts/online_predictor.gd")

# --- Mock helpers ----------------------------------------------------

## Build a topology adapter by name; just delegates to TopologyFactory
## so tests use the same instances production code does.
static func make_topology(name: String) -> Object:
	return TopologyFactory.from_string(name)

## Empty walls. Most predictor scenarios don't need walls; the few that
## do can pass an Array of {ax, az, bx, bz} dicts directly.
static func no_walls() -> Array:
	return []

## Canonical pending-input record. Mirrors what arena.gd::_stream_input
## appends to pending_inputs. Future OnlinePredictor.reconcile will
## consume an Array of these.
static func make_input(
	seq: int, world_move: Vector2, sprint: bool, jump: bool, now_ms: int
) -> Dictionary:
	return {
		"seq": seq,
		"world_move": world_move,
		"sprint": sprint,
		"dt": 1.0 / 60.0,
		"jump": jump,
		"now_ms": now_ms,
	}

## Initial predictor state. C1's OnlinePredictor.init/reset will accept
## this exact shape (plus a Node reference, but the harness can stub
## that).
static func make_pred_state(pos: Vector2, sprint_energy: float = 100.0) -> Dictionary:
	return {
		"position": pos,
		"sprint_energy": sprint_energy,
		"sprinting": false,
		"jump_started_at_ms": -1,
	}

## Apply one tick the way OnlinePredictor.advance_tick will. This is a
## stand-in implementation that uses the same Movement.step + step_jump
## the production code uses, so the harness's expected outputs match
## what the extracted predictor will produce. When C1 lands, the
## predictor's advance_tick replaces this stand-in.
static func _advance_one(
	state: Dictionary,
	input: Dictionary,
	walls: Array,
	topology,
) -> Dictionary:
	var step := Movement.step(
		{
			"position": state["position"],
			"sprint_energy": state["sprint_energy"],
			"sprinting": state["sprinting"],
		},
		{
			"move": input["world_move"],
			"sprint": input["sprint"],
			"dt": input["dt"],
		},
		walls,
		topology,
	)
	var next_jump: int = Physics.step_jump(
		state["jump_started_at_ms"],
		bool(input["jump"]),
		int(input["now_ms"]),
	)
	return {
		"position": step["position"],
		"sprint_energy": step["sprint_energy"],
		"sprinting": bool(step["sprinting"]),
		"jump_started_at_ms": next_jump,
	}

# --- Demonstration tests --------------------------------------------

## A1's room simulate fixture has a TS counterpart. The GD harness here
## proves the analogous shape on the client side: a deterministic input
## stream drives an in-memory predictor state. Same pattern arena.gd's
## _advance_predicted_tick will follow once it's a class method.
func test_harness_walks_human_x_at_walk_speed() -> void:
	var topology = make_topology("plane")
	var state := make_pred_state(Vector2.ZERO)
	var now_ms: int = 1_700_000_000_000
	for seq in range(1, 61):
		var input := make_input(seq, Vector2(1.0, 0.0), false, false, now_ms)
		state = _advance_one(state, input, no_walls(), topology)
		now_ms += int(input["dt"] * 1000.0)
	# 60 ticks * 3.2 m/s * (1/60) s = 3.2 m. Same expected value the
	# room.ts simulate harness asserts for the analogous TS scenario.
	assert_approx(state["position"].x, 3.2, 0.001, "walk +x ending position")
	assert_approx(state["position"].y, 0.0, 0.001, "z (Vector2.y) stays at 0")
	assert_false(state["sprinting"], "no sprint on a walk")

func test_harness_sprint_depletes_energy() -> void:
	var topology = make_topology("plane")
	var state := make_pred_state(Vector2.ZERO, 100.0)
	var now_ms: int = 1_700_000_000_000
	# 240 ticks @ SPRINT_DRAIN_PER_S=25 over 4 s depletes 100 -> 0.
	for seq in range(1, 241):
		var input := make_input(seq, Vector2(0.0, 1.0), true, false, now_ms)
		state = _advance_one(state, input, no_walls(), topology)
		now_ms += int(input["dt"] * 1000.0)
	assert_approx(state["sprint_energy"], 0.0, 0.001, "sprint depleted")
	assert_false(state["sprinting"], "sprint latched off at zero energy")

func test_harness_jump_lockout_via_step_jump() -> void:
	# Predictor must respect the lockout: a held jump only triggers once
	# per arc. Run one tick with jump=true, then 30 more without, then a
	# tick with jump=true at the very end. First should trigger; the
	# middle 30 stay locked; the final retries after the arc + cooldown.
	var topology = make_topology("plane")
	var state := make_pred_state(Vector2.ZERO)
	var now_ms: int = 1_700_000_000_000
	state = _advance_one(
		state, make_input(1, Vector2.ZERO, false, true, now_ms), no_walls(), topology
	)
	var first_jump: int = int(state["jump_started_at_ms"])
	assert_true(first_jump >= 0, "first jump triggered")
	# Tick deep into the arc; held jump must not re-trigger.
	now_ms += 100
	state = _advance_one(
		state, make_input(2, Vector2.ZERO, false, true, now_ms), no_walls(), topology
	)
	assert_eq(
		int(state["jump_started_at_ms"]),
		first_jump,
		"held jump during arc must not retrigger",
	)

## Reconcile loop sketch: the future OnlinePredictor.reconcile takes a
## server-authoritative position + the queue of pending inputs the
## client sent since the last ack, and produces the replayed position
## by running _advance_one for each pending input. Today this lives
## inline in arena.gd::_reconcile_local_player; the harness here
## exercises the same pure-function chain to lock the expected shape.
func test_harness_reconcile_replay_chain() -> void:
	var topology = make_topology("plane")
	# Pretend the server confirmed input seq=10, position (1.0, 0.0).
	# Pending: seqs 11..15 carrying +x walk inputs. Replayed result
	# should be 1.0 + 5*WALK_SPEED*(1/60) = 1.0 + 5 * 0.0533... m.
	var state := make_pred_state(Vector2(1.0, 0.0))
	var now_ms: int = 1_700_000_000_000
	for seq in range(11, 16):
		state = _advance_one(
			state, make_input(seq, Vector2(1.0, 0.0), false, false, now_ms), no_walls(), topology
		)
		now_ms += int((1.0 / 60.0) * 1000.0)
	var expected_x := 1.0 + 5.0 * SharedConstants.WALK_SPEED / 60.0
	assert_approx(state["position"].x, expected_x, 0.001, "5-input replay landing position")

# Regression for the jump snap AND the phantom re-jump. The local player owns
# its own jumps: reconcile keeps the predicted arc for the full lockout and never
# starts an arc from the server's authoritative state (a jump the server applied
# late under load would otherwise replay as a second jump after the real one).
func test_resolve_jump_keeps_predicted_arc_for_lockout_and_never_adopts_server() -> void:
	var lockout_ms := int((Physics.JUMP_DURATION_S + Physics.JUMP_COOLDOWN_S) * 1000.0)
	# Young arc: keep it (plays out, no mid-air snap).
	assert_eq(
		OnlinePredictor.resolve_jump_started_at(100000, 100000 + 100),
		100000,
		"a predicted arc plays out without being cancelled mid-flight",
	)
	# Still within the lockout (past the visible arc, in cooldown): keep it so the
	# client's cooldown matches the server's and we don't predict a too-soon jump.
	assert_eq(
		OnlinePredictor.resolve_jump_started_at(100000, 100000 + lockout_ms - 1),
		100000,
		"holds the start through the cooldown so re-press timing matches the server",
	)
	# Past the lockout: ground out.
	assert_eq(
		OnlinePredictor.resolve_jump_started_at(100000, 100000 + lockout_ms + 1),
		-1,
		"grounds out once the lockout has elapsed",
	)
	# No predicted arc: stay grounded. There is no `replayed` arg any more, so a
	# late server-side jump can never be adopted into a phantom second jump.
	assert_eq(
		OnlinePredictor.resolve_jump_started_at(-1, 100000),
		-1,
		"never starts an arc the local player did not predict",
	)
