extends "res://tests/test_case.gd"

## Cross-language determinism: read the JSON fixture written by
## scripts/gen-movement-fixture.ts (running the canonical TS
## stepMovement) and assert that GDScript Movement.step produces
## byte-equivalent final state for the same input stream.
##
## A failure means client and server drifted - reconciliation replay
## would then diverge from the server's authoritative simulation.

const Movement := preload("res://scripts/movement.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

const FIXTURE_PATH := "res://tests/fixtures/movement_snapshot.json"
# Godot's Vector2 is single-precision (f32) unless the engine was compiled
# with --enable-double-precision. The canonical TS uses f64. So a 300-tick
# scenario accumulates ~2e-4 of irreducible cross-language drift even when
# the algorithms agree exactly. Tolerance set to 1e-3 (1mm) so genuine
# algorithmic drift fails the test while precision noise passes. Note: the
# reconcile loop snaps any drift larger than CORRECTION_THRESHOLD = 0.05 m
# in arena.gd, so 1 mm is far below the gameplay-visible threshold.
const POSITION_TOLERANCE := 0.001
const SPRINT_TOLERANCE := 0.01

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing at %s - run `pnpm gen:movement-fixture`" % FIXTURE_PATH)
		return {}
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		assert_true(false, "fixture JSON is not a Dictionary")
		return {}
	return parsed

func _run_scenario(scenario: Dictionary) -> Dictionary:
	var initial: Dictionary = scenario["initial"]
	var input_dict: Dictionary = scenario["input"]
	var topology_name: String = scenario["topology"]
	var topology = TopologyFactory.from_string(topology_name)
	var walls: Array = scenario.get("walls", [])
	var ticks: int = int(scenario["ticks"])

	var pos_dict: Dictionary = initial["position"]
	var state: Dictionary = {
		"position": Vector2(float(pos_dict["x"]), float(pos_dict["z"])),
		"sprint_energy": float(initial["sprintEnergy"]),
		"sprinting": bool(initial["sprinting"]),
	}
	var move_dict: Dictionary = input_dict["move"]
	# Movement.step's input uses Vector2 with .x and .y where y maps to z.
	var input: Dictionary = {
		"move": Vector2(float(move_dict["x"]), float(move_dict["z"])),
		"sprint": bool(input_dict["sprint"]),
		"dt": float(input_dict["dt"]),
	}
	for _i in range(ticks):
		state = Movement.step(state, input, walls, topology)
	return state

func _assert_scenario_matches(scenario: Dictionary) -> void:
	var name: String = scenario["name"]
	var final: Dictionary = scenario["final"]
	var pos_dict: Dictionary = final["position"]
	var expected_x: float = float(pos_dict["x"])
	var expected_z: float = float(pos_dict["z"])
	var expected_sprint: float = float(final["sprintEnergy"])
	var expected_sprinting: bool = bool(final["sprinting"])

	var got: Dictionary = _run_scenario(scenario)
	var got_pos: Vector2 = got["position"]
	assert_approx(got_pos.x, expected_x, POSITION_TOLERANCE, "%s: position.x" % name)
	assert_approx(got_pos.y, expected_z, POSITION_TOLERANCE, "%s: position.z" % name)
	assert_approx(
		float(got["sprint_energy"]),
		expected_sprint,
		SPRINT_TOLERANCE,
		"%s: sprintEnergy" % name,
	)
	assert_eq(bool(got["sprinting"]), expected_sprinting, "%s: sprinting" % name)

func test_fixture_schema_version() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	var v: int = int(fixture.get("schemaVersion", 0))
	assert_eq(v, 1, "fixture schema must match the reader version")

func test_walk_plus_x_plane_60_ticks() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario_matches(fixture["scenarios"][0])

func test_sprint_plus_z_to_depletion() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario_matches(fixture["scenarios"][1])

func test_wall_rebound() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario_matches(fixture["scenarios"][2])

func test_torus_plus_x_seam_wrap() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario_matches(fixture["scenarios"][3])

func test_idle_sprint_regen() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario_matches(fixture["scenarios"][4])
