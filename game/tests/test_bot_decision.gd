extends "res://tests/test_case.gd"

## Mirrors backend/room/src/botDecision.test.ts.

const BotDecision := preload("res://scripts/bot_decision.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

const PARAMS := {
	"vision_radius": 22.0,
	"shoot_range": 18.0,
	"retarget_hysteresis": 0.75,
	"investigate_ms": 3000.0,
}

var _topo := PlaneTopology.new()

func _p(id: String, team: String, x: float, z: float, frozen := false) -> Dictionary:
	return {"id": id, "team": team, "position": Vector3(x, 0.5, z), "frozen": frozen, "cloak_until": 0.0}

func _bot() -> Dictionary:
	return _p("bot", "mime", 0, 0)

func _decide(bot, roster, active, eng, walls := [], now := 1000.0) -> Dictionary:
	return BotDecision.decide(bot, roster, walls, _topo, now, active, eng, PARAMS)

func test_patrols_when_idle() -> void:
	var b := _bot()
	var d := _decide(b, [b], "mime", BotDecision.new_engagement())
	assert_eq(d.mode, "patrol", "patrol")
	assert_false(d.chasing, "not chasing")

func test_chases_visible_enemy_on_own_turn() -> void:
	var b := _bot()
	var e := _p("e", "clown", 5, 0)
	var eng := BotDecision.new_engagement()
	var d := _decide(b, [b, e], "mime", eng)
	assert_eq(d.mode, "chase", "chase")
	assert_eq(d.target.get("id", ""), "e", "target enemy")
	assert_eq(eng.engaged_target_id, "e", "engagement recorded")
	assert_true(d.can_shoot, "in shoot range, clear LOS")

func test_flees_on_enemy_turn() -> void:
	var b := _bot()
	var e := _p("e", "clown", 5, 0)
	var d := _decide(b, [b, e], "clown", BotDecision.new_engagement())
	assert_eq(d.mode, "flee", "flee")
	assert_false(d.can_shoot, "no shooting while fleeing")

func test_rescues_frozen_ally_when_idle() -> void:
	var b := _bot()
	var a := _p("a", "mime", 4, 0, true)
	var d := _decide(b, [b, a], "mime", BotDecision.new_engagement())
	assert_eq(d.mode, "rescue", "rescue")
	assert_eq(d.rescue_target.get("id", ""), "a", "rescue target")

func test_flee_beats_rescue_but_keeps_flag() -> void:
	var b := _bot()
	var e := _p("e", "clown", 5, 0)
	var a := _p("a", "mime", 4, 0, true)
	var d := _decide(b, [b, e, a], "clown", BotDecision.new_engagement())
	assert_eq(d.mode, "flee", "flee wins")
	assert_true(d.rescuing, "rescue flag still live")

func test_hysteresis_keeps_engaged_target() -> void:
	var b := _bot()
	var a := _p("A", "clown", 10, 0)
	var bb := _p("B", "clown", 8, 0)
	var eng := {"engaged_target_id": "A", "last_known_pos": null, "investigate_until": 0.0}
	var d := _decide(b, [b, a, bb], "mime", eng)
	# B at 8 >= 10*0.75=7.5, so hysteresis keeps A.
	assert_eq(d.target.get("id", ""), "A", "keeps A")

func test_retargets_when_clearly_closer() -> void:
	var b := _bot()
	var a := _p("A", "clown", 10, 0)
	var bb := _p("B", "clown", 6, 0)
	var eng := {"engaged_target_id": "A", "last_known_pos": null, "investigate_until": 0.0}
	var d := _decide(b, [b, a, bb], "mime", eng)
	# B at 6 < 7.5, so switch.
	assert_eq(d.target.get("id", ""), "B", "switches to B")

func test_investigates_on_occlusion_during_own_turn() -> void:
	var b := _bot()
	var e := _p("e", "clown", 10, 0)
	var wall := [{"ax": 3.0, "az": -6.0, "bx": 3.0, "bz": 6.0}]
	var eng := {"engaged_target_id": "e", "last_known_pos": null, "investigate_until": 0.0}
	var d := _decide(b, [b, e], "mime", eng, wall)
	assert_true(d.target.is_empty(), "no visible target")
	assert_eq(d.mode, "investigate", "investigate last known")
	assert_true(eng.last_known_pos != null, "remembered position")
	assert_true(eng.investigate_until > 1000.0, "investigate window set")

func test_drops_target_on_occlusion_during_enemy_turn() -> void:
	var b := _bot()
	var e := _p("e", "clown", 10, 0)
	var wall := [{"ax": 3.0, "az": -6.0, "bx": 3.0, "bz": 6.0}]
	var eng := {"engaged_target_id": "e", "last_known_pos": null, "investigate_until": 0.0}
	var d := _decide(b, [b, e], "clown", eng, wall)
	assert_eq(d.mode, "patrol", "drops to patrol")
	assert_eq(eng.engaged_target_id, "", "engagement cleared")

func test_clears_stale_investigate_after_window() -> void:
	var b := _bot()
	var eng := {"engaged_target_id": "", "last_known_pos": Vector3(10, 0.5, 0), "investigate_until": 500.0}
	var d := _decide(b, [b], "mime", eng, [], 1000.0)
	assert_eq(d.mode, "patrol", "investigate expired")
	assert_eq(eng.last_known_pos, null, "memory cleared")
	assert_eq(eng.investigate_until, 0.0, "window reset")
