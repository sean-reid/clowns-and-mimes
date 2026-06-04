extends "res://tests/test_case.gd"

## Cross-language bot-flee determinism. Reads the fixture written by
## scripts/gen-bot-flee-fixture.ts and asserts the GDScript BotFlee.best_flee_target
## lands on the same escape point as the canonical TS bestFleeTarget for each
## scenario - locking the enemy-distance reward, dead-end + blocked penalties,
## and the quantized argmax tie-break across both engines.

const BotFlee := preload("res://scripts/bot_flee.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_flee_snapshot.json"
const TOLERANCE := 0.001

var _topo := PlaneTopology.new()

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-flee-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _vec(d: Dictionary) -> Vector3:
	return Vector3(float(d.x), 0.0, float(d.z))

func _assert_scenario(sc: Dictionary, projection: float) -> void:
	var name: String = sc.name
	var enemies: Array = []
	for e in sc.enemies:
		enemies.append(_vec(e))
	# Wall dicts ({ax,az,bx,bz}) come straight from JSON, matching what
	# WallGeometry.path_crosses_wall reads (same as the decision determinism test).
	var goal := BotFlee.best_flee_target(
		_vec(sc.bot), _vec(sc.threat), enemies, sc.walls, _topo, projection
	)
	var want: Dictionary = sc.expected
	assert_approx(goal.x, float(want.goalX), TOLERANCE, "%s: goal.x" % name)
	assert_approx(goal.z, float(want.goalZ), TOLERANCE, "%s: goal.z" % name)

func test_flee_targets_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var projection := float(fixture.projection)
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, projection)
