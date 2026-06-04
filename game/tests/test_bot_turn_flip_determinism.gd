extends "res://tests/test_case.gd"

## Cross-language bot-turn-flip determinism. Reads the fixture written by
## scripts/gen-bot-turn-flip-fixture.ts and asserts the GDScript
## BotTurnFlip.turn_flip_reposition returns the same pre-position target (or null)
## as the canonical TS turnFlipReposition - locking the retreat / pounce-standoff
## geometry and the imminence + can-tag gates across both engines.

const BotTurnFlip := preload("res://scripts/bot_turn_flip.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_turn_flip_snapshot.json"
const TOLERANCE := 0.001

var _topo := PlaneTopology.new()

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-turn-flip-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _assert_scenario(sc: Dictionary, p: Dictionary) -> void:
	var name: String = sc.name
	var got: Variant = BotTurnFlip.turn_flip_reposition(
		Vector3(float(sc.bot.x), 0.0, float(sc.bot.z)),
		Vector3(float(sc.enemy.x), 0.0, float(sc.enemy.z)),
		float(sc.timeToFlipMs),
		bool(sc.botIsHunter),
		_topo,
		float(p.anticipateMs),
		float(p.tagRadius),
		float(p.standoffBuffer),
		float(p.sprintSpeed),
		float(p.fleeProjection)
	)
	var ex: Variant = sc.expected
	if ex == null:
		assert_true(got == null, "%s: expected null" % name)
		return
	assert_true(got != null, "%s: expected a target" % name)
	if got != null:
		assert_approx(got.x, float(ex.x), TOLERANCE, "%s: x" % name)
		assert_approx(got.z, float(ex.z), TOLERANCE, "%s: z" % name)

func test_turn_flip_matches_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var p: Dictionary = fixture.params
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, p)
