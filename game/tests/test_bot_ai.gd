extends "res://tests/test_case.gd"

const BotAIScript := preload("res://scripts/bot_ai.gd")
const GameRulesScript := preload("res://scripts/game_rules.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")
const PlayerScript := preload("res://scripts/player.gd")

func _make_setup() -> Dictionary:
	var topology: TopologyScript = PlaneTopology.new()
	var rules: Node = GameRulesScript.new()
	rules.topology = topology
	var player: CharacterBody3D = CharacterBody3D.new()
	player.set_script(PlayerScript)
	player.team = "mime"
	player.bot = true
	player.is_local = false
	player.global_position = Vector3.ZERO
	var ai: Node = BotAIScript.new()
	ai.attach(player, "self", rules, topology)
	rules.register_player("self", "mime", Vector3.ZERO, "self", true)
	return {"rules": rules, "ai": ai, "player": player, "topology": topology}

func test_patrol_pick_before_attach_is_safe() -> void:
	# A bot's _ready fires on add_child, BEFORE attach() wires rules/pathfinder
	# (that's the real offline spawn order). The initial patrol pick must not
	# touch the un-attached state - this guards the regression where team-spread
	# read rules.players on a null rules and crashed at match start.
	var tree := Engine.get_main_loop() as SceneTree
	var body := CharacterBody3D.new()
	tree.root.add_child(body)
	var ai: Node = BotAIScript.new()
	body.add_child(ai)  # fires _ready -> _commit_patrol_target with no rules yet
	assert_true(is_instance_valid(ai), "bot _ready survived spawning before attach")
	body.free()

func test_chase_state_when_enemy_visible_during_own_turn() -> void:
	var ctx: Dictionary = _make_setup()
	var rules: Node = ctx["rules"]
	var ai: Node = ctx["ai"]
	rules.register_player("e", "clown", Vector3(5.0, 0.0, 0.0), "E", true)
	rules.phase = GameRulesScript.Phase.TURN_MIME
	ai._choose_state()
	assert_eq(ai.state, BotAIScript.State.CHASE, "chase enemy on own turn")
	ai._choose_target()
	assert_approx(ai.patrol_target.x, 5.0, 0.001, "target is enemy position")

func test_flee_state_during_opponent_turn() -> void:
	var ctx: Dictionary = _make_setup()
	var rules: Node = ctx["rules"]
	var ai: Node = ctx["ai"]
	rules.register_player("e", "clown", Vector3(5.0, 0.0, 0.0), "E", true)
	rules.phase = GameRulesScript.Phase.TURN_CLOWN
	ai._choose_state()
	assert_eq(ai.state, BotAIScript.State.FLEE, "flee on opponent turn")
	ai._choose_target()
	# Flee target should be opposite of enemy direction.
	assert_true(ai.patrol_target.x < 0.0, "flee target points away")

func test_rescue_state_when_teammate_frozen_nearby() -> void:
	var ctx: Dictionary = _make_setup()
	var rules: Node = ctx["rules"]
	var ai: Node = ctx["ai"]
	rules.register_player("t", "mime", Vector3(3.0, 0.0, 0.0), "T", true)
	rules.players["t"]["frozen"] = true
	rules.phase = GameRulesScript.Phase.TURN_MIME
	ai._choose_state()
	assert_eq(ai.state, BotAIScript.State.RESCUE, "rescue takes priority")

func test_patrol_when_no_targets() -> void:
	var ctx: Dictionary = _make_setup()
	var ai: Node = ctx["ai"]
	ai._choose_state()
	assert_eq(ai.state, BotAIScript.State.PATROL, "patrol with no targets")

# Pass-bias parity: these mirror the botSteering.ts passBiasDir unit tests so the
# offline swerve produces the same numbers as the online one.
func test_pass_bias_veers_right_of_neighbour_ahead() -> void:
	var ctx: Dictionary = _make_setup()
	var ai: Node = ctx["ai"]
	# dir=+x, neighbour 2 ahead, radius 4, weight 1 -> lateral 0.5 toward +z.
	var d: Vector3 = ai._pass_bias_dir(Vector3(1, 0, 0), [Vector3(2, 0, 0)], 4.0, 1.0)
	assert_approx(d.x, 0.894427, 0.0001, "keeps a forward bias")
	assert_approx(d.z, 0.447214, 0.0001, "swerves to the right (+z)")

func test_pass_bias_head_on_pair_splits() -> void:
	var ctx: Dictionary = _make_setup()
	var ai: Node = ctx["ai"]
	var a: Vector3 = ai._pass_bias_dir(Vector3(1, 0, 0), [Vector3(2, 0, 0)], 4.0, 1.0)
	var b: Vector3 = ai._pass_bias_dir(Vector3(-1, 0, 0), [Vector3(-2, 0, 0)], 4.0, 1.0)
	assert_true(a.z > 0.0, "bot facing +x swerves +z")
	assert_true(b.z < 0.0, "bot facing -x swerves -z")
	assert_approx(a.z, -b.z, 0.0001, "the pair splits symmetrically")

func test_stabilize_yaw_holds_against_micro_and_hunting_but_adopts_real_turns() -> void:
	var ctx: Dictionary = _make_setup()
	var ai: Node = ctx["ai"]
	# deadband 0.06, reversal_break 0.6, commit_ticks 10
	# Sub-deadband re-aim: hold, wind down the counter.
	var micro: Dictionary = ai._stabilize_yaw(1.0, 4, 1.03, 0.06, 0.6, 10)
	assert_approx(micro["yaw"], 1.0, 0.0001, "micro re-aim held")
	assert_eq(micro["hold"], 3, "hold winds down")
	# Mid-size reversal inside the commit window: hold.
	var hunt: Dictionary = ai._stabilize_yaw(1.0, 5, 1.3, 0.06, 0.6, 10)
	assert_approx(hunt["yaw"], 1.0, 0.0001, "mid-size reversal held mid-commit")
	assert_eq(hunt["hold"], 4, "hold winds down")
	# Same mid-size change once the hold expired: adopt + re-commit.
	var adopt: Dictionary = ai._stabilize_yaw(1.0, 0, 1.3, 0.06, 0.6, 10)
	assert_approx(adopt["yaw"], 1.3, 0.0001, "adopts once hold expires")
	assert_eq(adopt["hold"], 10, "re-commits")
	# Large change: adopt immediately even mid-commit.
	var course: Dictionary = ai._stabilize_yaw(1.0, 8, 1.8, 0.06, 0.6, 10)
	assert_approx(course["yaw"], 1.8, 0.0001, "large change adopted at once")
	assert_eq(course["hold"], 10, "re-commits")

func test_stabilize_yaw_measures_change_across_the_pi_seam() -> void:
	var ctx: Dictionary = _make_setup()
	var ai: Node = ctx["ai"]
	# target just under PI, raw just past -PI: shortest delta is tiny -> hold.
	var r: Dictionary = ai._stabilize_yaw(PI - 0.02, 6, -PI + 0.02, 0.06, 0.6, 10)
	assert_approx(r["yaw"], PI - 0.02, 0.0001, "seam-wrapped delta stays under deadband")
	assert_eq(r["hold"], 5, "hold winds down")

func test_pass_bias_ignores_neighbour_behind() -> void:
	var ctx: Dictionary = _make_setup()
	var ai: Node = ctx["ai"]
	var d: Vector3 = ai._pass_bias_dir(Vector3(1, 0, 0), [Vector3(-2, 0, 0)], 4.0, 1.0)
	assert_approx(d.x, 1.0, 0.0001, "heading unchanged")
	assert_approx(d.z, 0.0, 0.0001, "no swerve for a neighbour behind")

func test_pass_neighbor_offsets_filters_by_radius() -> void:
	var ctx: Dictionary = _make_setup()
	var rules: Node = ctx["rules"]
	var ai: Node = ctx["ai"]
	rules.register_player("near", "clown", Vector3(2, 0, 0), "N", true)
	rules.register_player("far", "clown", Vector3(20, 0, 0), "F", true)
	var offs: Array = ai._pass_neighbor_offsets()
	assert_eq(offs.size(), 1, "only the in-radius neighbour is returned")
	assert_approx(offs[0].x, 2.0, 0.001, "offset is wrap-relative to the bot")
