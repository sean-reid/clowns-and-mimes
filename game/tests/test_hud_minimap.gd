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

func test_smooth_axis_non_wrapping_lerps_straight() -> void:
	# Plane axis: the dot slides directly toward the target, no edge hop.
	var r: float = Minimap._smooth_axis(0.1, 0.5, 0.5, false)
	assert_approx(r, 0.3, 0.001, "non-wrapping midpoint lerp")

func test_smooth_axis_wrapping_takes_short_path_off_edge() -> void:
	# Near the right edge (0.95) heading for the left edge (0.05): the short
	# path is forward across the seam, so the dot moves PAST 1.0 and wraps back
	# into [0,1] near the right edge - never sweeping back across the middle.
	# 0.95 toward 0.10: short path heads forward toward the wrapped target 1.10,
	# so the dot edges right toward the seam (0.9875) instead of sweeping left
	# across the whole map.
	var r: float = Minimap._smooth_axis(0.95, 0.10, 0.25, true)
	assert_approx(r, 0.9875, 0.001, "wrap forward across seam stays near edge")
	# Reverse direction: 0.10 toward 0.90 heads backward toward wrapped target
	# -0.10, so the dot edges left toward the seam (0.05), not right across the map.
	var back: float = Minimap._smooth_axis(0.10, 0.90, 0.25, true)
	assert_approx(back, 0.05, 0.001, "wrap backward across seam stays near edge")

func test_smooth_axis_wrapping_no_seam_when_close() -> void:
	# Targets within half a map width lerp straight even on a wrapping axis.
	var r: float = Minimap._smooth_axis(0.2, 0.6, 0.5, true)
	assert_approx(r, 0.4, 0.001, "wrapping but short-range lerp")

func test_smooth_axis_endpoints_are_the_same_point() -> void:
	# 0.0 and 1.0 are the same world position on a wrapping axis, so smoothing
	# between them must not drift the dot across the map.
	var r: float = Minimap._smooth_axis(0.0, 1.0, 0.5, true)
	assert_approx(r, 0.0, 0.001, "0 and 1 coincide on a seam")

func test_fold_near_copy_keeps_orientation() -> void:
	# Viewer on the near copy (local_copy=false), a dot also on the near half
	# (u<0.5): not opposite, so v is preserved and u scales onto the single copy.
	var f: Dictionary = Minimap._fold_to_local(Vector2(0.25, 0.3), false)
	assert_eq(f["opposite"], false, "near-copy dot is not opposite")
	assert_approx(f["pos"].x, 0.5, 0.001, "near u scales x2")
	assert_approx(f["pos"].y, 0.3, 0.001, "near v unchanged")

func test_fold_far_copy_mirrors_and_flags() -> void:
	# Viewer on the near copy, a dot on the far half (u>=0.5): opposite, so it
	# folds onto its deck partner with v mirrored, and is flagged for dimming.
	var f: Dictionary = Minimap._fold_to_local(Vector2(0.75, 0.3), false)
	assert_eq(f["opposite"], true, "far-copy dot is opposite")
	assert_approx(f["pos"].x, 0.5, 0.001, "far u folds to same column as its partner")
	assert_approx(f["pos"].y, 0.7, 0.001, "far v mirrors")

func test_fold_deck_partners_share_a_column() -> void:
	# A point and its deck partner (u and u+0.5) project to the same screen
	# column, so folding lands the unseen-side dot exactly on its partner's x.
	var near: Dictionary = Minimap._fold_to_local(Vector2(0.2, 0.4), false)
	var partner: Dictionary = Minimap._fold_to_local(Vector2(0.7, 0.4), false)
	assert_approx(near["pos"].x, partner["pos"].x, 0.001, "partners share a column")

func test_fold_is_relative_to_viewer_copy() -> void:
	# When the viewer is on the far copy (local_copy=true), the classification
	# inverts: a near-half dot is now the opposite side and mirrors/dims.
	var f: Dictionary = Minimap._fold_to_local(Vector2(0.25, 0.3), true)
	assert_eq(f["opposite"], true, "near dot is opposite when viewer is far")
	assert_approx(f["pos"].y, 0.7, 0.001, "v mirrors relative to viewer")
