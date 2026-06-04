extends "res://tests/test_case.gd"

## Cross-language bot-leap determinism. Reads the fixture written by
## scripts/gen-bot-leap-fixture.ts and asserts the GDScript
## BotLeap.should_leap_traverse agrees with the canonical TS shouldLeapTraverse
## for each scenario - locking the wall-in-the-way / clear-landing predicate
## across both engines.

const BotLeap := preload("res://scripts/bot_leap.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_leap_snapshot.json"

var _topo := PlaneTopology.new()

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-leap-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _assert_scenario(sc: Dictionary, reach: float) -> void:
	var name: String = sc.name
	var leap: bool = BotLeap.should_leap_traverse(
		Vector3(float(sc.bot.x), 0.0, float(sc.bot.z)),
		Vector3(float(sc.goal.x), 0.0, float(sc.goal.z)),
		sc.walls,
		_topo,
		reach
	)
	assert_eq(leap, bool(sc.expected), "%s: should_leap_traverse" % name)

func test_leap_matches_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var reach := float(fixture.reach)
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, reach)
