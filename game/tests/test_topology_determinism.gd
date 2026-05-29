extends "res://tests/test_case.gd"

## Cross-language topology determinism. Reads the JSON fixture written by
## scripts/gen-topology-fixture.ts and asserts the GDScript per-topology
## adapters produce the same wrap and distance results.
##
## Distance feeds tag-radius checks; wrap defines the canonical domain.
## A drift here (especially for Möbius / Klein with their non-orientable
## seam rules) would cause client/server tag-accept disagreement.

const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

const FIXTURE_PATH := "res://tests/fixtures/topology_snapshot.json"
const TOLERANCE := 0.0001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing at %s - run `pnpm gen:topology-fixture`" % FIXTURE_PATH)
		return {}
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		assert_true(false, "fixture JSON is not a Dictionary")
		return {}
	return parsed

func _to_vec3(v: Dictionary) -> Vector3:
	return Vector3(float(v["x"]), 0.0, float(v["z"]))

func _assert_topology(scenario: Dictionary) -> void:
	var topology_name: String = scenario["topology"]
	var topology = TopologyFactory.from_string(topology_name)
	var wrap_tests: Array = scenario["wrapTests"]
	for i in range(wrap_tests.size()):
		var t: Dictionary = wrap_tests[i]
		var input_v: Vector3 = _to_vec3(t["input"])
		var expected: Dictionary = t["expected"]
		var got: Vector3 = topology.wrap(input_v)
		assert_approx(
			got.x,
			float(expected["x"]),
			TOLERANCE,
			"%s wrap [%d]: x" % [topology_name, i],
		)
		assert_approx(
			got.z,
			float(expected["z"]),
			TOLERANCE,
			"%s wrap [%d]: z" % [topology_name, i],
		)
	var distance_tests: Array = scenario["distanceTests"]
	for i in range(distance_tests.size()):
		var t: Dictionary = distance_tests[i]
		var a: Vector3 = _to_vec3(t["a"])
		var b: Vector3 = _to_vec3(t["b"])
		var expected: float = float(t["expected"])
		var got: float = topology.distance(a, b)
		assert_approx(got, expected, TOLERANCE, "%s distance [%d]" % [topology_name, i])

func test_fixture_schema_version() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	assert_eq(int(fixture.get("schemaVersion", 0)), 1, "fixture schema must match reader version")

func test_plane() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_topology(fixture["scenarios"][0])

func test_torus() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_topology(fixture["scenarios"][1])

func test_mobius() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_topology(fixture["scenarios"][2])

func test_klein() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	_assert_topology(fixture["scenarios"][3])
