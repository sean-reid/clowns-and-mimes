extends "res://tests/test_case.gd"

const TopologyScript := preload("res://scripts/topology/topology.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")
const TorusTopology := preload("res://scripts/topology/torus_topology.gd")
const KleinTopology := preload("res://scripts/topology/klein_topology.gd")
const MobiusTopology := preload("res://scripts/topology/mobius_topology.gd")
const Genus2Topology := preload("res://scripts/topology/genus2_topology.gd")
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

func test_genus2_extents_match_octagon_bounding_box() -> void:
	var g := Genus2Topology.new()
	assert_approx(g.extent_x(), 80.0, 0.001, "genus2 extent_x = 2 * circumradius")
	assert_approx(g.extent_z(), 80.0, 0.001, "genus2 extent_z = 2 * circumradius")

func test_genus2_origin_is_inside_octagon() -> void:
	var g := Genus2Topology.new()
	assert_true(g.point_in_octagon(Vector2(0.0, 0.0)), "origin inside octagon")
	assert_true(g.point_in_octagon(Vector2(5.0, 3.0)), "interior point inside")
	# A probe well past a side is outside.
	assert_false(g.point_in_octagon(Vector2(100.0, 0.0)), "far +x outside")

func test_genus2_mate_pairing() -> void:
	var g := Genus2Topology.new()
	# 0<->2, 1<->3, 4<->6, 5<->7
	assert_eq(g.mate_side(0), 2)
	assert_eq(g.mate_side(2), 0)
	assert_eq(g.mate_side(1), 3)
	assert_eq(g.mate_side(5), 7)
	for k in range(8):
		assert_eq(g.mate_side(g.mate_side(k)), k, "mate self-inverse on side %d" % k)

func test_genus2_wrap_step_identifies_to_mate_side() -> void:
	var g := Genus2Topology.new()
	# Step just past side 0's midpoint outward; landing should sit inside
	# the octagon near side 2's midpoint (mate of side 0).
	var mid_x: float = 0.5 * (Genus2Topology.OCTAGON_CIRCUMRADIUS + cos(PI / 4.0) * Genus2Topology.OCTAGON_CIRCUMRADIUS)
	var mid_z: float = 0.5 * (0.0 + sin(PI / 4.0) * Genus2Topology.OCTAGON_CIRCUMRADIUS)
	# Outward normal for side 0 from V0=(R,0) to V1=(R*cos45, R*sin45):
	#   tangent t = (V1 - V0) / |...|, outward = (t.y, -t.x).
	var r: float = Genus2Topology.OCTAGON_CIRCUMRADIUS
	var v0 := Vector2(r, 0.0)
	var v1 := Vector2(cos(PI / 4.0) * r, sin(PI / 4.0) * r)
	var tangent: Vector2 = (v1 - v0).normalized()
	var outward := Vector2(tangent.y, -tangent.x)
	var prev := Vector3(mid_x - 0.5 * outward.x, 0.0, mid_z - 0.5 * outward.y)
	var next := Vector3(mid_x + 0.3 * outward.x, 0.0, mid_z + 0.3 * outward.y)
	var out := g.wrap_step(prev, next)
	assert_true(g.point_in_octagon(Vector2(out.x, out.z)), "wrap_step lands inside octagon")

func test_genus2_portal_transform_glues_mate_vertices_to_source() -> void:
	# For each side k, applying the portal transform to V_m (mate's start
	# vertex) should yield V_{k+1}, and applying it to V_{m+1} should yield
	# V_k. That's the geometric meaning of the gluing rule with parameter
	# flip: the mate side's interior is rotated/translated so its V_m end
	# sits on top of V_{k+1} and its V_{m+1} end on V_k.
	var g := Genus2Topology.new()
	for k in 8:
		var t: Dictionary = g.portal_transform(k)
		var m: int = g.mate_side(k)
		var v_m: Vector2 = g._side_starts[m]
		var v_m_plus_1: Vector2 = g._side_ends[m]
		var v_k: Vector2 = g._side_starts[k]
		var v_k_plus_1: Vector2 = g._side_ends[k]
		var rotation_y: float = t["rotation_y"]
		var positive: bool = rotation_y > 0.0
		var apply_x: Callable = func(p: Vector2):
			var rx: float = (-p.y if positive else p.y)
			var rz: float = (p.x if positive else -p.x)
			return Vector2(rx + t["tx"], rz + t["tz"])
		var t_vm: Vector2 = apply_x.call(v_m)
		var t_vm_plus_1: Vector2 = apply_x.call(v_m_plus_1)
		assert_approx(t_vm.x, v_k_plus_1.x, 0.001, "side %d: T(V_m).x = V_{k+1}.x" % k)
		assert_approx(t_vm.y, v_k_plus_1.y, 0.001, "side %d: T(V_m).y = V_{k+1}.y" % k)
		assert_approx(t_vm_plus_1.x, v_k.x, 0.001, "side %d: T(V_{m+1}).x = V_k.x" % k)
		assert_approx(t_vm_plus_1.y, v_k.y, 0.001, "side %d: T(V_{m+1}).y = V_k.y" % k)

func test_genus2_portal_transform_rotation_sign_alternates() -> void:
	var g := Genus2Topology.new()
	for k in 8:
		var t: Dictionary = g.portal_transform(k)
		var rotation_y: float = t["rotation_y"]
		assert_approx(absf(rotation_y), PI / 2.0, 0.001, "side %d magnitude = 90 deg" % k)
		var expect_forward: bool = k == 0 or k == 1 or k == 4 or k == 5
		assert_eq(rotation_y > 0.0, expect_forward, "side %d rotation sign" % k)

func test_mobius_extents_match_2_to_1_rectangle() -> void:
	var m := MobiusTopology.new()
	assert_approx(m.extent_x(), 80.0, 0.001, "mobius extent_x = 2*Lx")
	assert_approx(m.extent_z(), 40.0, 0.001, "mobius extent_z = 2*Lz")

func test_mobius_wrap_step_crosses_right_with_z_flip() -> void:
	var m := MobiusTopology.new()
	var prev := Vector3(MobiusTopology.MOBIUS_HALF_X - 0.5, 0.0, 5.0)
	var next := Vector3(MobiusTopology.MOBIUS_HALF_X + 0.3, 0.0, 5.0)
	var out := m.wrap_step(prev, next)
	assert_true(out.x < 0.0, "wrap landed on the far left, x=%f" % out.x)
	assert_true(out.z < 0.0, "z was negated, z=%f" % out.z)
	assert_approx(absf(out.z), 5.0, 0.5, "|z| close to original 5")

func test_mobius_wrap_step_blocks_top_hard_wall() -> void:
	var m := MobiusTopology.new()
	var prev := Vector3(0.0, 0.0, MobiusTopology.MOBIUS_HALF_Z - 0.1)
	var next := Vector3(0.0, 0.0, MobiusTopology.MOBIUS_HALF_Z + 1.0)
	var out := m.wrap_step(prev, next)
	assert_eq(out.x, prev.x, "x stays")
	assert_approx(out.z, prev.z, 0.001, "blocked at hard top wall")

func test_mobius_portal_transforms_pair() -> void:
	var m := MobiusTopology.new()
	var pts: Array = m.portal_transforms()
	assert_eq(pts.size(), 2, "two portal tiles (left + right)")
	# Applying the right portal to the left edge should land on the
	# right edge: (-Lx + 2*Lx, -z) = (Lx, -z). The portal renders the
	# strip's interior continuously past the right seam.
	var right_t: Dictionary = pts[0]
	var left_x: float = -MobiusTopology.MOBIUS_HALF_X
	var mapped_x: float = left_x + right_t["tx"]
	assert_approx(mapped_x, MobiusTopology.MOBIUS_HALF_X, 0.001, "right portal maps -Lx -> +Lx")
	assert_true(right_t["flip_z"], "right portal flips z")

func test_factory_returns_correct_kind() -> void:
	assert_eq(TopologyFactory.from_string("plane").kind(), TopologyScript.Kind.PLANE)
	assert_eq(TopologyFactory.from_string("torus").kind(), TopologyScript.Kind.TORUS)
	assert_eq(TopologyFactory.from_string("mobius").kind(), TopologyScript.Kind.MOBIUS)
	assert_eq(TopologyFactory.from_string("klein").kind(), TopologyScript.Kind.KLEIN)
	assert_eq(TopologyFactory.from_string("genus2").kind(), TopologyScript.Kind.GENUS2)
