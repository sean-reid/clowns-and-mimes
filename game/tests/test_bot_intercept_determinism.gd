extends "res://tests/test_case.gd"

## Cross-language bot-intercept determinism. Reads the fixture written by
## scripts/gen-bot-intercept-fixture.ts and asserts the GDScript
## BotIntercept.intercept_point lands on the same predicted lead point as the
## canonical TS interceptPoint for each scenario, so predictive aim / chase
## interception stays identical online and offline.

const BotIntercept := preload("res://scripts/bot_intercept.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_intercept_snapshot.json"
const TOLERANCE := 0.001

var _topo := PlaneTopology.new()

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-intercept-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _assert_scenario(sc: Dictionary) -> void:
	var name: String = sc.name
	var p := BotIntercept.intercept_point(
		Vector3(float(sc.shooter.x), 0.0, float(sc.shooter.z)),
		Vector3(float(sc.target.x), 0.0, float(sc.target.z)),
		Vector3(float(sc.vel.x), 0.0, float(sc.vel.z)),
		float(sc.speed),
		_topo
	)
	assert_approx(p.x, float(sc.expected.x), TOLERANCE, "%s: x" % name)
	assert_approx(p.z, float(sc.expected.z), TOLERANCE, "%s: z" % name)

func test_intercept_points_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc)
