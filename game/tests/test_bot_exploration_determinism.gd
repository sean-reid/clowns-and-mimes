extends "res://tests/test_case.gd"

## Cross-language bot-exploration determinism. Reads the fixture written by
## scripts/gen-bot-exploration-fixture.ts and asserts the GDScript
## BotExploration.patrol_candidate_score matches the canonical TS
## patrolCandidateScore for each scenario.

const BotExploration := preload("res://scripts/bot_exploration.gd")

const FIXTURE_PATH := "res://tests/fixtures/bot_exploration_snapshot.json"
const TOLERANCE := 0.001

func _load_fixture() -> Dictionary:
	var file := FileAccess.open(FIXTURE_PATH, FileAccess.READ)
	if file == null:
		assert_true(false, "fixture missing - run `pnpm gen:bot-exploration-fixture`")
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}

func _assert_scenario(sc: Dictionary, now: float, params: Dictionary) -> void:
	var name: String = sc.name
	var visited: Dictionary = {}
	for k in sc.visited:
		visited[int(k)] = float(sc.visited[k])
	var score := BotExploration.patrol_candidate_score(
		Vector3(float(sc.candidateX), 0.0, float(sc.candidateZ)),
		int(sc.candidateCell),
		Vector3(float(sc.botX), 0.0, float(sc.botZ)),
		Vector3(float(sc.headingX), 0.0, float(sc.headingZ)),
		visited,
		now,
		float(params.decayMs),
		float(params.momentumBonus)
	)
	assert_approx(score, float(sc.expected), TOLERANCE, "%s: score" % name)

func test_exploration_scores_match_fixture() -> void:
	var fixture := _load_fixture()
	if fixture.is_empty():
		return
	var now := float(fixture.now)
	var params: Dictionary = fixture.params
	var scenarios: Array = fixture["scenarios"]
	assert_true(scenarios.size() > 0, "fixture has scenarios")
	for sc in scenarios:
		_assert_scenario(sc, now, params)
