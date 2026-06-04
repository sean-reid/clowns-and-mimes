extends SceneTree

## Minimal headless test runner. Loads each script in TEST_SCRIPTS, calls every
## `test_*` method on a fresh instance, collects failures via TestCase, prints
## a summary, and exits non-zero if anything failed.

const TestCase := preload("res://tests/test_case.gd")

const TEST_SCRIPTS: Array[String] = [
	"res://tests/test_topology.gd",
	"res://tests/test_labyrinth.gd",
	"res://tests/test_wall_geometry.gd",
	"res://tests/test_bot_pathfinder.gd",
	"res://tests/test_bot_pathfinder_determinism.gd",
	"res://tests/test_bot_perception.gd",
	"res://tests/test_bot_decision.gd",
	"res://tests/test_bot_decision_determinism.gd",
	"res://tests/test_bot_goals_determinism.gd",
	"res://tests/test_bot_items_determinism.gd",
	"res://tests/test_bot_coordination_determinism.gd",
	"res://tests/test_bot_exploration_determinism.gd",
	"res://tests/test_bot_flee_determinism.gd",
	"res://tests/test_offline_items.gd",
	"res://tests/test_offline_items_determinism.gd",
	"res://tests/test_offline_mode_lifecycle.gd",
	"res://tests/test_projectiles_determinism.gd",
	"res://tests/test_portals_determinism.gd",
	"res://tests/test_username_generator.gd",
	"res://tests/test_game_rules.gd",
	"res://tests/test_bot_ai.gd",
	"res://tests/test_version_check.gd",
	"res://tests/test_physics.gd",
	"res://tests/test_frozen_descent.gd",
	"res://tests/test_movement_determinism.gd",
	"res://tests/test_gridmaze_determinism.gd",
	"res://tests/test_topology_determinism.gd",
	"res://tests/test_physics_determinism.gd",
	"res://tests/test_mobius_determinism.gd",
	"res://tests/test_predictor_harness.gd",
	"res://tests/test_projectile_renderer.gd",
	"res://tests/test_item_renderer.gd",
	"res://tests/test_portal_renderer.gd",
	"res://tests/test_hud_minimap.gd",
	"res://tests/test_wall_uplight_tint.gd",
	"res://tests/test_tutorial_overlay.gd",
]

func _initialize() -> void:
	var total_pass: int = 0
	var total_fail: int = 0
	for path in TEST_SCRIPTS:
		var script: GDScript = load(path) as GDScript
		if script == null:
			push_error("could not load %s" % path)
			total_fail += 1
			continue
		for method in script.get_script_method_list():
			var n: String = method["name"]
			if not n.begins_with("test_"):
				continue
			TestCase.failures.clear()
			var instance: RefCounted = script.new()
			instance.call(n)
			if TestCase.failures.is_empty():
				total_pass += 1
				print("PASS %s::%s" % [path, n])
			else:
				total_fail += 1
				print("FAIL %s::%s" % [path, n])
				for f in TestCase.failures:
					print("  %s" % f)
	print("[runner] %d passed, %d failed" % [total_pass, total_fail])
	quit(0 if total_fail == 0 else 1)
