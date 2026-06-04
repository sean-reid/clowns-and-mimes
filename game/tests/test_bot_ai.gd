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
