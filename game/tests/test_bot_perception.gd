extends "res://tests/test_case.gd"

## Mirrors backend/room/src/botPerception.test.ts.

const BotPerception := preload("res://scripts/bot_perception.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

var _topo := PlaneTopology.new()

func _p(id: String, team: String, x: float, z: float, frozen := false, cloak := 0.0) -> Dictionary:
	return {"id": id, "team": team, "position": Vector3(x, 0.5, z), "frozen": frozen, "cloak_until": cloak}

func _bot() -> Dictionary:
	return _p("bot", "mime", 0, 0)

func test_nearest_visible_enemy_picks_closest() -> void:
	var bot := _bot()
	var near := _p("near", "clown", 3, 0)
	var far := _p("far", "clown", 9, 0)
	var got := BotPerception.nearest_visible_enemy(bot, [bot, far, near], [], _topo, 0.0)
	assert_eq(got.get("id", ""), "near", "nearest enemy")

func test_nearest_visible_enemy_skips_ally_frozen_cloaked() -> void:
	var bot := _bot()
	var ally := _p("ally", "mime", 1, 0)
	var frozen := _p("fz", "clown", 2, 0, true)
	var cloaked := _p("ck", "clown", 3, 0, false, 1000.0)
	var real := _p("real", "clown", 8, 0)
	var got := BotPerception.nearest_visible_enemy(bot, [bot, ally, frozen, cloaked, real], [], _topo, 0.0)
	assert_eq(got.get("id", ""), "real", "skips ally/frozen/cloaked")

func test_nearest_visible_enemy_skips_occluded() -> void:
	var bot := _bot()
	var walls := [{"ax": 5.0, "az": -5.0, "bx": 5.0, "bz": 5.0}]
	var behind := _p("behind", "clown", 10, 0)
	var got := BotPerception.nearest_visible_enemy(bot, [bot, behind], walls, _topo, 0.0)
	assert_true(got.is_empty(), "occluded enemy not visible")

func test_nearest_enemy_sees_through_walls_and_cloak() -> void:
	var bot := _bot()
	var walls := [{"ax": 5.0, "az": -5.0, "bx": 5.0, "bz": 5.0}]
	var cloaked := _p("ck", "clown", 10, 0, false, 1000.0)
	var got := BotPerception.nearest_enemy(bot, [bot, cloaked], _topo)
	assert_eq(got.target.get("id", ""), "ck", "radar sees through everything")

func test_nearest_frozen_ally_within_radius() -> void:
	var bot := _bot()
	var a := _p("a", "mime", 5, 0, true)
	var b := _p("b", "mime", 2, 0, true)
	var got := BotPerception.nearest_frozen_ally(bot, [bot, a, b], _topo, 22.0)
	assert_eq(got.target.get("id", ""), "b", "nearest frozen teammate")

func test_nearest_frozen_ally_ignores_far_and_enemy() -> void:
	var bot := _bot()
	var enemy_frozen := _p("ef", "clown", 1, 0, true)
	var far := _p("far", "mime", 30, 0, true)
	var got := BotPerception.nearest_frozen_ally(bot, [bot, enemy_frozen, far], _topo, 22.0)
	assert_true(got.target.is_empty(), "no qualifying frozen ally")
