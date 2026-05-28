extends "res://tests/test_case.gd"

## Cross-language physics fixture. Reads scripts/gen-physics-fixture.ts
## output and asserts Physics.jump_arc_y and Physics.is_jumping match
## the canonical TS implementation byte-for-byte (pure parabolic + lockout
## logic; no accumulation).
##
## Lower drift risk than movement/topology fixtures (each case is one
## function call, no per-tick loop) but the test is cheap insurance against
## a future change to the arc formula on one side.

const Physics := preload("res://scripts/physics.gd")

const FIXTURE_PATH := "res://tests/fixtures/physics_snapshot.json"
const TOLERANCE := 0.0001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing at %s - run `pnpm gen:physics-fixture`" % FIXTURE_PATH)
		return {}
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		assert_true(false, "fixture JSON is not a Dictionary")
		return {}
	return parsed

# JSON.parse_string maps a JS `null` to a Variant null. The fixture
# encodes the GDScript -1 sentinel as JS null; translate here.
func _started_at(v: Variant) -> int:
	if v == null:
		return -1
	return int(v)

func test_fixture_schema_version() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	assert_eq(int(fixture.get("schemaVersion", 0)), 1, "fixture schema must match reader version")

func test_arc_y_matches_canonical() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	var cases: Array = fixture["arcCases"]
	for c in cases:
		var case: Dictionary = c
		var label: String = case["label"]
		var started_at_ms: int = _started_at(case.get("startedAtMs"))
		var now_ms: int = int(case["nowMs"])
		var expected: float = float(case["expectedY"])
		var got: float = Physics.jump_arc_y(started_at_ms, now_ms)
		assert_approx(got, expected, TOLERANCE, "arc %s" % label)

func test_is_jumping_matches_canonical() -> void:
	var fixture: Dictionary = _load_fixture()
	if fixture.is_empty():
		return
	var cases: Array = fixture["jumpingCases"]
	for c in cases:
		var case: Dictionary = c
		var label: String = case["label"]
		var started_at_ms: int = _started_at(case.get("startedAtMs"))
		var now_ms: int = int(case["nowMs"])
		var expected: bool = bool(case["expectedJumping"])
		var got: bool = Physics.is_jumping(started_at_ms, now_ms)
		assert_eq(got, expected, "is_jumping %s" % label)
