extends "res://tests/test_case.gd"

const GameRulesScript := preload("res://scripts/game_rules.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

func _make_rules() -> Node:
	var rules: Node = GameRulesScript.new()
	rules.topology = PlaneTopology.new()
	return rules

func test_tag_requires_active_team_turn() -> void:
	var rules: Node = _make_rules()
	rules.register_player("a", "mime", Vector3(0.0, 0.0, 0.0), "A", false)
	rules.register_player("b", "clown", Vector3(0.5, 0.0, 0.0), "B", false)
	rules.phase = GameRulesScript.Phase.TURN_CLOWN
	# Mime cannot tag while clowns are active.
	assert_false(rules.try_tag("a", "b"), "tag rejected when off-turn")
	# Clown can tag during clown turn.
	assert_true(rules.try_tag("b", "a"), "tag accepted on turn")
	assert_true(rules.players["a"]["frozen"], "victim is frozen")

func test_tag_requires_radius() -> void:
	var rules: Node = _make_rules()
	rules.register_player("a", "mime", Vector3(0.0, 0.0, 0.0), "A", false)
	rules.register_player("b", "clown", Vector3(5.0, 0.0, 0.0), "B", false)
	rules.phase = GameRulesScript.Phase.TURN_MIME
	assert_false(rules.try_tag("a", "b"), "tag rejected when out of range")

func test_tag_rejects_jumper_above_threshold() -> void:
	# Offline parity with the server's vertical-separation rejection.
	# Attacker at hover, victim at peak jump (HOVER + JUMP_AMP = 2.5) - the
	# gap is 2.0 m, well past BODY_VERTICAL_EXTENT (1.4 m). The tag should
	# be rejected with reason `vertical_separation` so the HUD can surface
	# "out of reach (jumped)".
	const Physics := preload("res://scripts/physics.gd")
	var rules: Node = _make_rules()
	rules.register_player("a", "mime", Vector3(0.0, Physics.HOVER_HEIGHT, 0.0), "A", false)
	rules.register_player("b", "clown", Vector3(0.5, Physics.HOVER_HEIGHT + Physics.JUMP_AMP, 0.0), "B", false)
	rules.phase = GameRulesScript.Phase.TURN_MIME
	var got: Array = []
	rules.tag_rejected.connect(func(_a, _v, reason): got.append(reason))
	assert_false(rules.try_tag("a", "b"), "tag rejected when victim is mid-jump")
	assert_eq(got.size(), 1, "single rejection emitted")
	assert_eq(got[0], "vertical_separation", "rejection reason is vertical_separation")

func test_unfreeze_requires_same_team_and_proximity() -> void:
	var rules: Node = _make_rules()
	rules.register_player("a", "mime", Vector3(0.0, 0.0, 0.0), "A", false)
	rules.register_player("b", "mime", Vector3(0.4, 0.0, 0.0), "B", false)
	rules.register_player("c", "clown", Vector3(0.4, 0.0, 0.0), "C", false)
	rules.players["b"]["frozen"] = true
	rules.players["c"]["frozen"] = true
	assert_true(rules.try_unfreeze("a", "b"), "teammate unfrozen")
	assert_false(rules.players["b"]["frozen"], "victim unfrozen")
	assert_false(rules.try_unfreeze("a", "c"), "cannot unfreeze opposing team")

func test_unfreeze_blocked_when_savior_frozen() -> void:
	var rules: Node = _make_rules()
	rules.register_player("a", "mime", Vector3(0.0, 0.0, 0.0), "A", false)
	rules.register_player("b", "mime", Vector3(0.4, 0.0, 0.0), "B", false)
	rules.players["a"]["frozen"] = true
	rules.players["b"]["frozen"] = true
	assert_false(rules.try_unfreeze("a", "b"), "frozen savior cannot save")

func test_win_emits_when_one_team_fully_frozen() -> void:
	var rules: Node = _make_rules()
	rules.register_player("a", "mime", Vector3(0.0, 0.0, 0.0), "A", false)
	rules.register_player("b", "clown", Vector3(0.4, 0.0, 0.0), "B", false)
	var winner: Array[String] = []
	rules.won.connect(func(team: String): winner.append(team))
	rules.phase = GameRulesScript.Phase.TURN_CLOWN
	assert_true(rules.try_tag("b", "a"), "clown tags mime")
	assert_eq(winner.size(), 1, "single win emitted")
	assert_eq(winner[0], "clown", "clown wins")

func test_turn_progression_advances_phase() -> void:
	var rules: Node = _make_rules()
	rules.start(PlaneTopology.new())
	assert_eq(rules.phase, GameRulesScript.Phase.FREE_ROAM, "starts in free roam")
	rules.phase_ends_at = 0.0
	rules.tick(1.0)
	assert_true(
		rules.phase == GameRulesScript.Phase.TURN_MIME or rules.phase == GameRulesScript.Phase.TURN_CLOWN,
		"advances to a team turn"
	)
