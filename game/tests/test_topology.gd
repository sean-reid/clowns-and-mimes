extends "res://tests/test_case.gd"

const TopologyScript := preload("res://scripts/topology/topology.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")
const TorusTopology := preload("res://scripts/topology/torus_topology.gd")
const KleinTopology := preload("res://scripts/topology/klein_topology.gd")
const SphereTopology := preload("res://scripts/topology/sphere_topology.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

const W := TopologyScript.WIDTH
const H := W / 2.0

func test_plane_clamps_to_bounds() -> void:
	var plane := PlaneTopology.new()
	var p := plane.wrap(Vector3(200.0, 0.0, -200.0))
	assert_eq(p.x, H, "plane clamp x")
	assert_eq(p.z, -H, "plane clamp z")

func test_plane_passes_inside_through() -> void:
	var plane := PlaneTopology.new()
	var p := plane.wrap(Vector3(5.0, 0.0, -7.0))
	assert_eq(p.x, 5.0, "inside x")
	assert_eq(p.z, -7.0, "inside z")

func test_torus_wraps_both_axes() -> void:
	var torus := TorusTopology.new()
	var p := torus.wrap(Vector3(H + 20.0, 0.0, 0.0))
	assert_approx(p.x, -H + 20.0, 0.001, "torus wrap x")
	var q := torus.wrap(Vector3(0.0, 0.0, -H - 20.0))
	assert_approx(q.z, H - 20.0, 0.001, "torus wrap z")

func test_torus_distance_takes_shortest_path() -> void:
	var torus := TorusTopology.new()
	var d := torus.distance(Vector3(-H + 5.0, 0.0, 0.0), Vector3(H - 5.0, 0.0, 0.0))
	assert_approx(d, 10.0, 0.001, "torus shortest distance")

func test_klein_double_cover_wrap() -> void:
	# Klein is now a 2W x W double cover: x wraps with period 2W and z with
	# period W. The bottle's z-orientation flip is in the geometry of the
	# right half (z-mirrored), not in the wrap rule.
	var klein := KleinTopology.new()
	# Inside the x domain [-W, W], wrap is a no-op.
	var p := klein.wrap(Vector3(H + 20.0, 0.0, 20.0))
	assert_approx(p.x, H + 20.0, 0.001, "klein no-op inside double cover")
	assert_approx(p.z, 20.0, 0.001, "klein z preserved inside")
	# Past x=W (the 2W seam at x=+W), wrap pulls back across the full 2W period.
	var q := klein.wrap(Vector3(W + 10.0, 0.0, 5.0))
	assert_approx(q.x, -W + 10.0, 0.001, "klein x wraps at 2W")
	assert_approx(q.z, 5.0, 0.001, "klein z stays modular only")

func test_sphere_wrap_t_net() -> void:
	# Sphere is a cube T-net (4 x 3 face slots). A point on a face slot
	# returns unchanged; a point in the void or off the playfield snaps to
	# the nearest face center (best-effort recovery; the runtime predictor
	# uses wrap_step for motion crossings).
	var sphere := SphereTopology.new()
	# (10, 5) is on the +Z face (center column, middle row).
	var inside := sphere.wrap(Vector3(10.0, 0.0, 5.0))
	assert_approx(inside.x, 10.0, 0.001, "sphere passes through valid face point")
	assert_approx(inside.z, 5.0, 0.001, "sphere passes through valid face point z")

func test_factory_returns_correct_kind() -> void:
	assert_eq(TopologyFactory.from_string("plane").kind(), TopologyScript.Kind.PLANE)
	assert_eq(TopologyFactory.from_string("torus").kind(), TopologyScript.Kind.TORUS)
	assert_eq(TopologyFactory.from_string("klein").kind(), TopologyScript.Kind.KLEIN)
	assert_eq(TopologyFactory.from_string("sphere").kind(), TopologyScript.Kind.SPHERE)
