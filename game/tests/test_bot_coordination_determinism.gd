extends "res://tests/test_case.gd"

## Cross-language bot-coordination determinism. Reads the fixture written by
## scripts/gen-bot-coordination-fixture.ts and asserts the GDScript
## BotCoordination.assign_rescues / assign_chases produce the same matching as
## the canonical TS side for each roster - the bot->ally rescue pairing
## (including the id tiebreak) and the bot->{target, flank goal} chase pincers.

const BotCoordination := preload("res://scripts/bot_coordination.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_coordination_snapshot.json"
const TOLERANCE := 0.001

var _topo := PlaneTopology.new()

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-coordination-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _player(spec: Dictionary) -> Dictionary:
	return {
		"id": spec.id,
		"team": spec.team,
		"bot": spec.get("bot", true),
		"position": Vector3(float(spec.x), 0.5, float(spec.z)),
		"frozen": spec.get("frozen", false),
	}

func _roster(sc: Dictionary) -> Array:
	var roster: Array = []
	for spec in sc.players:
		roster.append(_player(spec))
	return roster

func _assert_scenario(sc: Dictionary, vision: float) -> void:
	var name: String = sc.name
	var claims := BotCoordination.assign_rescues(_roster(sc), _topo, vision)
	var expected: Dictionary = sc.expected
	# Every expected claim matches.
	for bot_id in expected:
		assert_true(claims.has(bot_id), "%s: %s should have a claim" % [name, bot_id])
		if claims.has(bot_id):
			assert_eq(claims[bot_id].target.id, expected[bot_id], "%s: %s claim" % [name, bot_id])
	# No extra claims beyond the expected set.
	assert_eq(claims.size(), expected.size(), "%s: claim count" % name)

func _assert_chase_scenario(sc: Dictionary, now: float) -> void:
	var name: String = sc.name
	var claims := BotCoordination.assign_chases(_roster(sc), [], _topo, now)
	var expected: Dictionary = sc.expected
	for bot_id in expected:
		assert_true(claims.has(bot_id), "%s: %s should have a chase claim" % [name, bot_id])
		if claims.has(bot_id):
			var got: Dictionary = claims[bot_id]
			var want: Dictionary = expected[bot_id]
			assert_eq(got.target_id, want.targetId, "%s: %s target" % [name, bot_id])
			assert_approx(got.goal.x, float(want.goalX), TOLERANCE, "%s: %s goal.x" % [name, bot_id])
			assert_approx(got.goal.z, float(want.goalZ), TOLERANCE, "%s: %s goal.z" % [name, bot_id])
	assert_eq(claims.size(), expected.size(), "%s: chase claim count" % name)

func test_coordination_matches_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var vision := float(fixture.vision)
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, vision)

func test_chase_coordination_matches_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var now := float(fixture.get("now", 1000.0))
	var scenarios: Array = fixture.get("chaseScenarios", [])
	assert_true(scenarios.size() > 0, "fixture has chase scenarios")
	for sc in scenarios:
		_assert_chase_scenario(sc, now)
