extends "res://tests/test_case.gd"

## Cross-language bot-decision determinism. Reads the fixture written by
## scripts/gen-bot-decision-fixture.ts and asserts the GDScript BotDecision.decide
## produces the same mode, target, flags, and mutated engagement as the canonical
## TS decideBotAction for each scenario.

const BotDecision := preload("res://scripts/bot_decision.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_decision_snapshot.json"
const TOLERANCE := 0.01

var _topo := PlaneTopology.new()

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-decision-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _player(spec: Dictionary) -> Dictionary:
	return {
		"id": spec.id, "team": spec.team,
		"position": Vector3(float(spec.x), 0.5, float(spec.z)),
		"frozen": spec.get("frozen", false), "cloak_until": 0.0,
	}

func _id_or_empty(s: Variant) -> String:
	return "" if s == null else str(s)

func _assert_scenario(sc: Dictionary) -> void:
	var name: String = sc.name
	var bot := _player(sc.bot)
	var roster: Array = [bot]
	for p in sc.players:
		roster.append(_player(p))
	var ein: Dictionary = sc.engagementIn
	var lk: Variant = null
	if ein.lastKnownPos != null:
		lk = Vector3(float(ein.lastKnownPos.x), 0.0, float(ein.lastKnownPos.z))
	var eng := {
		"engaged_target_id": _id_or_empty(ein.engagedTargetId),
		"last_known_pos": lk,
		"investigate_until": float(ein.investigateUntil),
	}
	var params := {
		"vision_radius": 22.0, "shoot_range": 18.0,
		"retarget_hysteresis": 0.75, "investigate_ms": 3000.0,
	}
	var d := BotDecision.decide(
		bot, roster, sc.walls, _topo, float(sc.now), _id_or_empty(sc.active), eng, params
	)
	var ex: Dictionary = sc.expected

	assert_eq(d.mode, ex.mode, "%s: mode" % name)
	assert_eq(_id_or_empty(d.target.get("id") if not d.target.is_empty() else null), _id_or_empty(ex.targetId), "%s: target" % name)
	assert_eq(_id_or_empty(d.rescue_target.get("id") if not d.rescue_target.is_empty() else null), _id_or_empty(ex.rescueTargetId), "%s: rescue target" % name)
	assert_eq(d.chasing, ex.chasing, "%s: chasing" % name)
	assert_eq(d.fleeing, ex.fleeing, "%s: fleeing" % name)
	assert_eq(d.rescuing, ex.rescuing, "%s: rescuing" % name)
	assert_eq(d.investigating, ex.investigating, "%s: investigating" % name)
	assert_eq(d.can_shoot, ex.canShoot, "%s: can_shoot" % name)
	if ex.enemyDist != null:
		assert_approx(d.enemy_dist, float(ex.enemyDist), TOLERANCE, "%s: enemy_dist" % name)

	# Engagement mutated in place must match the TS engagement-out.
	var eout: Dictionary = ex.engagementOut
	assert_eq(eng.engaged_target_id, _id_or_empty(eout.engagedTargetId), "%s: engaged out" % name)
	assert_approx(eng.investigate_until, float(eout.investigateUntil), TOLERANCE, "%s: investigate_until out" % name)
	if eout.lastKnownPos == null:
		assert_true(eng.last_known_pos == null, "%s: last_known cleared" % name)
	else:
		assert_true(eng.last_known_pos != null, "%s: last_known set" % name)
		if eng.last_known_pos != null:
			assert_approx(eng.last_known_pos.x, float(eout.lastKnownPos.x), TOLERANCE, "%s: lk x" % name)
			assert_approx(eng.last_known_pos.z, float(eout.lastKnownPos.z), TOLERANCE, "%s: lk z" % name)

func test_decisions_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc)
