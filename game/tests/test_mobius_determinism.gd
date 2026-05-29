extends "res://tests/test_case.gd"

## Cross-language fixture for stepAcrossMobiusBoundary (TS) -> wrap_step
## (GDScript MobiusTopology). Drives the JSON fixture written by
## scripts/gen-mobius-fixture.ts and asserts the GDScript adapter
## returns the same (x, z) for each (prev, next) pair.
##
## stepAcrossMobiusBoundary is the only step-aware wrap in the codebase
## - the strip's hard z bounds reject motion that crosses them, while x
## wraps modular without a z-flip. Drift between the two implementations
## would let the client predict a wrap the server rejected (or vice
## versa) and surface as snap-back jitter at the seam.

const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

const FIXTURE_PATH := "res://tests/fixtures/mobius_snapshot.json"
const TOLERANCE := 0.0001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing at %s - run `pnpm gen:mobius-fixture`" % FIXTURE_PATH)
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

func test_fixture_schema_version() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	assert_eq(int(fixture.get("schemaVersion", 0)), 1, "fixture schema must match reader version")

func test_step_across_mobius_boundary() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	var topology = TopologyFactory.from_string("mobius")
	var step_tests: Array = fixture["stepTests"]
	for i in range(step_tests.size()):
		var t: Dictionary = step_tests[i]
		var prev: Vector3 = _to_vec3(t["prev"])
		var next: Vector3 = _to_vec3(t["next"])
		var expected: Dictionary = t["expected"]
		var got: Vector3 = topology.wrap_step(prev, next)
		var label: String = "[%d] %s" % [i, t.get("name", "")]
		assert_approx(got.x, float(expected["x"]), TOLERANCE, "%s: x" % label)
		assert_approx(got.z, float(expected["z"]), TOLERANCE, "%s: z" % label)
