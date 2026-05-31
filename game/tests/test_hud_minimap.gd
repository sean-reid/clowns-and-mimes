extends "res://tests/test_case.gd"

## White-box tests for the minimap's pure projection. project_normalized maps a
## world XZ position into [0,1]^2 using the topology's full extent, so the dot
## lands in the same relative spot regardless of how wide the playfield is. The
## runner executes before the tree is up, so we exercise the static helpers
## against the real topology adapters rather than a live widget.

const Minimap := preload("res://scripts/hud_minimap.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

func test_center_maps_to_middle() -> void:
	for name in ["plane", "torus", "mobius", "klein"]:
		var t = TopologyFactory.from_string(name)
		var n: Vector2 = Minimap.project_normalized(Vector3.ZERO, t)
		assert_approx(n.x, 0.5, 0.001, "%s center u" % name)
		assert_approx(n.y, 0.5, 0.001, "%s center v" % name)

func test_corners_map_to_extremes() -> void:
	var t = TopologyFactory.from_string("plane")
	var lo: Vector2 = Minimap.project_normalized(Vector3(-40, 0, -40), t)
	var hi: Vector2 = Minimap.project_normalized(Vector3(40, 0, 40), t)
	assert_approx(lo.x, 0.0, 0.001, "plane -x edge")
	assert_approx(lo.y, 0.0, 0.001, "plane -z edge")
	assert_approx(hi.x, 1.0, 0.001, "plane +x edge")
	assert_approx(hi.y, 1.0, 0.001, "plane +z edge")

func test_wide_extent_uses_full_span() -> void:
	# Mobius is 160 wide / 40 deep, so the same world x reads as a smaller
	# normalized offset than on the square plane.
	var t = TopologyFactory.from_string("mobius")
	var n: Vector2 = Minimap.project_normalized(Vector3(80, 0, 20), t)
	assert_approx(n.x, 1.0, 0.001, "mobius +x edge")
	assert_approx(n.y, 1.0, 0.001, "mobius +z edge")
	var mid: Vector2 = Minimap.project_normalized(Vector3(40, 0, 0), t)
	assert_approx(mid.x, 0.75, 0.001, "mobius quarter-span x")
	assert_approx(mid.y, 0.5, 0.001, "mobius center z")

func test_out_of_bounds_clamps() -> void:
	var t = TopologyFactory.from_string("plane")
	var over: Vector2 = Minimap.project_normalized(Vector3(999, 0, -999), t)
	assert_approx(over.x, 1.0, 0.001, "clamp high")
	assert_approx(over.y, 0.0, 0.001, "clamp low")

func test_to_vec3_accepts_dict() -> void:
	var v: Vector3 = Minimap._to_vec3({"x": 1.0, "y": 2.0, "z": 3.0})
	assert_approx(v.x, 1.0, 0.001, "dict x")
	assert_approx(v.z, 3.0, 0.001, "dict z")
