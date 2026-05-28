extends "res://tests/test_case.gd"

## Cross-language gridMaze determinism. Reads the fixture written by
## scripts/gen-gridmaze-fixture.ts and asserts the GDScript GridMaze.generate
## produces the exact same wall list for the same (seed, topology) input.
##
## A divergence here is catastrophic: client and server would walk through
## different mazes for the same room.

const GridMaze := preload("res://scripts/grid_maze.gd")

const FIXTURE_PATH := "res://tests/fixtures/gridmaze_snapshot.json"
# Integer cell coordinates pass through float math but always land on
# exact half-integer worldspace values. Use a small float tolerance
# anyway to absorb any future tweak to the cell-to-world mapping.
const TOLERANCE := 0.0001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing at %s - run `pnpm gen:gridmaze-fixture`" % FIXTURE_PATH)
		return {}
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		assert_true(false, "fixture JSON is not a Dictionary")
		return {}
	return parsed

func _assert_scenario(scenario: Dictionary) -> void:
	var name: String = scenario["name"]
	var seed_value: int = int(scenario["seed"])
	var topology: String = scenario["topology"]
	var expected: Array = scenario["walls"]

	var got: Array = GridMaze.generate(seed_value, topology)
	assert_eq(got.size(), expected.size(), "%s: wall count" % name)
	if got.size() != expected.size():
		return
	for i in range(got.size()):
		var g: Dictionary = got[i]
		var e: Dictionary = expected[i]
		assert_approx(float(g["ax"]), float(e["ax"]), TOLERANCE, "%s [%d]: ax" % [name, i])
		assert_approx(float(g["az"]), float(e["az"]), TOLERANCE, "%s [%d]: az" % [name, i])
		assert_approx(float(g["bx"]), float(e["bx"]), TOLERANCE, "%s [%d]: bx" % [name, i])
		assert_approx(float(g["bz"]), float(e["bz"]), TOLERANCE, "%s [%d]: bz" % [name, i])

func test_fixture_schema_version() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	assert_eq(int(fixture.get("schemaVersion", 0)), 1, "fixture schema must match reader version")

func test_plane_seed_0() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario(fixture["scenarios"][0])

func test_plane_seed_1() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario(fixture["scenarios"][1])

func test_plane_seed_12345() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario(fixture["scenarios"][2])

func test_torus_seed_0() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario(fixture["scenarios"][3])

func test_torus_seed_42() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario(fixture["scenarios"][4])

func test_klein_seed_7() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario(fixture["scenarios"][5])

func test_mobius_seed_3() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_scenario(fixture["scenarios"][6])
