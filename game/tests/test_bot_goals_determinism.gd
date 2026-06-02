extends "res://tests/test_case.gd"

## Cross-language bot-goals determinism. Reads the fixture written by
## scripts/gen-bot-goals-fixture.ts and asserts the GDScript
## BotGoals.nearest_item_target picks the same floor item (or null) as the
## canonical TS nearestItemTarget for each scenario.

const BotGoals := preload("res://scripts/bot_goals.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_goals_snapshot.json"
const TOLERANCE := 0.01

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-goals-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _assert_scenario(sc: Dictionary) -> void:
	var name: String = sc.name
	var topo := TopologyFactory.from_string(sc.topology)
	var items: Array = []
	for it in sc.items:
		items.append({"position": Vector3(float(it.x), 0.5, float(it.z))})
	var got: Variant = BotGoals.nearest_item_target(
		Vector3(float(sc.botX), 0.5, float(sc.botZ)), items, topo, float(sc.seekRadius)
	)
	var ex: Variant = sc.expected
	if ex == null:
		assert_true(got == null, "%s: expected null target" % name)
		return
	assert_true(got != null, "%s: expected a target, got null" % name)
	if got == null:
		return
	var dest: Vector3 = got
	assert_approx(dest.x, float(ex.x), TOLERANCE, "%s: target x" % name)
	assert_approx(dest.z, float(ex.z), TOLERANCE, "%s: target z" % name)

func test_goals_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc)
