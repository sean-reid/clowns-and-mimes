extends "res://tests/test_case.gd"

## Cross-language item-layout determinism. Reads the fixture written by
## scripts/gen-items-fixture.ts and asserts the GDScript OfflineItems produces
## the exact same rotation + floor layout (ids, types, positions, ordering) for
## the same (seed, topology). A divergence means offline and online would spawn
## different power-ups in the same room.

const OfflineItems := preload("res://scripts/offline_items.gd")

const FIXTURE_PATH := "res://tests/fixtures/items_snapshot.json"
const TOLERANCE := 0.0001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing at %s - run `pnpm gen:items-fixture`" % FIXTURE_PATH)
		return {}
	var raw := file.get_as_text()
	file.close()
	var parsed: Variant = JSON.parse_string(raw)
	if typeof(parsed) != TYPE_DICTIONARY:
		assert_true(false, "fixture JSON is not a Dictionary")
		return {}
	return parsed

func _assert_scenario(scenario: Dictionary) -> void:
	var sname: String = scenario["name"]
	var seed_value: int = int(scenario["seed"])
	var topology: String = scenario["topology"]

	var expected_rotation: Array = scenario["rotation"]
	var got_rotation: Array = OfflineItems.rotate_item_types(seed_value)
	assert_eq(got_rotation, expected_rotation, "%s: rotation" % sname)

	var expected: Array = scenario["items"]
	var got: Array = OfflineItems.item_spawn_layout(seed_value, topology)
	assert_eq(got.size(), expected.size(), "%s: item count" % sname)
	if got.size() != expected.size():
		return
	for i in got.size():
		var e: Dictionary = expected[i]
		var g: Dictionary = got[i]
		assert_eq(g.id, e.id, "%s[%d]: id" % [sname, i])
		assert_eq(g.type, e.type, "%s[%d]: type" % [sname, i])
		var ep: Dictionary = e.position
		assert_approx(g.position.x, float(ep.x), TOLERANCE, "%s[%d]: x" % [sname, i])
		assert_approx(g.position.z, float(ep.z), TOLERANCE, "%s[%d]: z" % [sname, i])

func test_layout_matches_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for scenario in scenarios:
		_assert_scenario(scenario)
