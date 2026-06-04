extends "res://tests/test_case.gd"

## Cross-language bot-projectile-threat determinism. Reads the fixture written by
## scripts/gen-bot-projectile-threat-fixture.ts and asserts the GDScript
## BotProjectileThreat.nearest_projectile_threat returns the same flee-from
## bearing (or null) as the canonical TS nearestProjectileThreat - locking the
## enemy / sight-range / line-of-sight / approaching filters and the
## reverse-trajectory bearing across both engines.

const BotProjectileThreat := preload("res://scripts/bot_projectile_threat.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_projectile_threat_snapshot.json"
const TOLERANCE := 0.001

var _topo := PlaneTopology.new()

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-projectile-threat-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _assert_scenario(sc: Dictionary, sight: float, lookback: float) -> void:
	var name: String = sc.name
	var bot := {
		"id": sc.bot.id,
		"team": sc.bot.team,
		"position": Vector3(float(sc.bot.x), 0.0, float(sc.bot.z)),
	}
	var projectiles: Array = []
	for p in sc.projectiles:
		projectiles.append({
			"owner_id": p.ownerId,
			"team": p.team,
			"position": Vector3(float(p.px), 0.0, float(p.pz)),
			"velocity": Vector3(float(p.vx), 0.0, float(p.vz)),
		})
	# Wall dicts ({ax,az,bx,bz}) come straight from JSON, as path_crosses_wall reads.
	var threat: Variant = BotProjectileThreat.nearest_projectile_threat(
		bot, projectiles, sc.walls, _topo, sight, lookback
	)
	if sc.expected == null:
		assert_true(threat == null, "%s: should perceive no threat" % name)
	else:
		assert_true(threat != null, "%s: should perceive a threat" % name)
		if threat != null:
			assert_approx(threat.x, float(sc.expected.x), TOLERANCE, "%s: bearing.x" % name)
			assert_approx(threat.z, float(sc.expected.z), TOLERANCE, "%s: bearing.z" % name)

func test_projectile_threat_matches_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var sight := float(fixture.sight)
	var lookback := float(fixture.lookback)
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, sight, lookback)
