extends "res://tests/test_case.gd"

## Cross-language bot-pathfinder determinism. Reads the fixture written by
## scripts/gen-bot-pathfinder-fixture.ts and asserts the GDScript BotPathfinder
## returns the same waypoint as the canonical TS one for each (walls, from, to)
## query. A divergence means offline and online bots route differently through
## the same maze - including any equal-cost A* tie-break the two resolve apart.

const BotPathfinder := preload("res://scripts/bot_pathfinder.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_pathfinder_snapshot.json"
const TOLERANCE := 0.001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing at %s - run `pnpm gen:bot-pathfinder-fixture`" % FIXTURE_PATH)
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
	var topology: String = scenario["topology"]
	var walls: Array = scenario["walls"]
	var queries: Array = scenario["queries"]
	var results: Array = scenario["results"]
	var pf := BotPathfinder.new(walls, topology)
	for i in queries.size():
		var q: Dictionary = queries[i]
		var expected: Dictionary = results[i]
		var from := Vector3(float(q.from.x), 0.0, float(q.from.z))
		var to := Vector3(float(q.to.x), 0.0, float(q.to.z))
		var wp: Vector3
		if q.has("avoid"):
			var avoid: Array = []
			for p in q["avoid"]:
				avoid.append(Vector3(float(p.x), 0.0, float(p.z)))
			wp = pf.next_waypoint_avoiding(from, to, avoid)
		else:
			wp = pf.next_waypoint(from, to)
		assert_approx(wp.x, float(expected.x), TOLERANCE, "%s q%d: waypoint x" % [sname, i])
		assert_approx(wp.z, float(expected.z), TOLERANCE, "%s q%d: waypoint z" % [sname, i])

func test_waypoints_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for scenario in scenarios:
		_assert_scenario(scenario)
