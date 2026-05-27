extends SceneTree

## Minimal headless test runner. Loads each script in TEST_SCRIPTS, calls every
## `test_*` method on a fresh instance, collects failures via TestCase, prints
## a summary, and exits non-zero if anything failed.

const TestCase := preload("res://tests/test_case.gd")

const TEST_SCRIPTS: Array[String] = [
	"res://tests/test_topology.gd",
	"res://tests/test_labyrinth.gd",
	"res://tests/test_username_generator.gd",
	"res://tests/test_game_rules.gd",
	"res://tests/test_bot_ai.gd",
	"res://tests/test_version_check.gd",
	"res://tests/test_physics.gd",
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
