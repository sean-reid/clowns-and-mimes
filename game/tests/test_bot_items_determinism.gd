extends "res://tests/test_case.gd"

## Cross-language bot-items determinism. Reads the fixture written by
## scripts/gen-bot-items-fixture.ts and asserts the GDScript
## BotItems.decide_item_use returns the same use flag and radar memory seed as
## the canonical TS decideItemUse for each scenario.

const BotItems := preload("res://scripts/bot_items.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_items_snapshot.json"
const TOLERANCE := 0.01

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-items-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _params(p: Dictionary) -> Dictionary:
	return {
		"sprint_trigger_radius": float(p.sprintTriggerRadius),
		"max_sprint": float(p.maxSprint),
		"tag_radius": float(p.tagRadius),
		"jump_evade_buffer": float(p.jumpEvadeBuffer),
	}

func _ctx(c: Dictionary) -> Dictionary:
	var seed: Variant = null
	if c.nearestEnemyPos != null:
		seed = Vector3(float(c.nearestEnemyPos.x), 0.0, float(c.nearestEnemyPos.z))
	return {
		"chasing": c.chasing,
		"fleeing": c.fleeing,
		"want_jump": c.wantJump,
		"can_shoot": c.canShoot,
		"enemy_dist": float(c.enemyDist),
		"sprint_energy": float(c.sprintEnergy),
		"has_actionable_enemy": c.hasActionableEnemy,
		"nearest_enemy_pos": seed,
	}

func _assert_scenario(sc: Dictionary, params: Dictionary) -> void:
	var name: String = sc.name
	var item: String = "" if sc.item == null else str(sc.item)
	var d := BotItems.decide_item_use(item, _ctx(sc.ctx), params)
	var ex: Dictionary = sc.expected
	assert_eq(d.use, ex.use, "%s: use" % name)
	if ex.memorySeed == null:
		assert_true(d.memory_seed == null, "%s: no memory seed" % name)
	else:
		assert_true(d.memory_seed != null, "%s: memory seed set" % name)
		if d.memory_seed != null:
			var seed: Vector3 = d.memory_seed
			assert_approx(seed.x, float(ex.memorySeed.x), TOLERANCE, "%s: seed x" % name)
			assert_approx(seed.z, float(ex.memorySeed.z), TOLERANCE, "%s: seed z" % name)

func test_items_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var params := _params(fixture.params)
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, params)
