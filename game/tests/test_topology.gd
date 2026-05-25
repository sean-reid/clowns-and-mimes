extends "res://tests/test_case.gd"

const TopologyScript := preload("res://scripts/topology/topology.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")
const TorusTopology := preload("res://scripts/topology/torus_topology.gd")
const KleinTopology := preload("res://scripts/topology/klein_topology.gd")
const SphereRhomboTopology := preload("res://scripts/topology/sphere_rhombicuboctahedron_topology.gd")
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

func test_sphere_rhombo_extents() -> void:
	# 8 cols x 7 rows of FACE_SIDE = WIDTH / 8 squares. Width should still be
	# WIDTH; height is 7/8 of WIDTH.
	var sphere := SphereRhomboTopology.new()
	assert_approx(sphere.extent_x(), TopologyScript.WIDTH, 0.001, "rhombo extent x")
	assert_approx(
		sphere.extent_z(),
		TopologyScript.WIDTH * 7.0 / 8.0,
		0.001,
		"rhombo extent z",
	)

func test_sphere_rhombo_walkable_face_count() -> void:
	# 6 axials + 8 cap edges + 4 equator edges = 18 walkable faces, all in
	# ADJACENCY. Triangles are in FACE_SLOTS but not in ADJACENCY.
	var sphere := SphereRhomboTopology.new()
	assert_eq(SphereRhomboTopology.ADJACENCY.size(), 18, "rhombo walkable count")
	assert_eq(SphereRhomboTopology.FACE_SLOTS.size(), 26, "rhombo total slot count")

func test_sphere_rhombo_adjacency_round_trip() -> void:
	# Every walkable-to-walkable edge round trips with rotations summing to
	# 0 mod 4. Mirror of the TypeScript foundation test.
	var sphere := SphereRhomboTopology.new()
	for face_key in SphereRhomboTopology.ADJACENCY.keys():
		var face: String = face_key
		for edge_key in SphereRhomboTopology.ADJACENCY[face].keys():
			var edge: String = edge_key
			var adj: Array = SphereRhomboTopology.ADJACENCY[face][edge]
			var to_face: String = adj[0]
			var to_edge: String = adj[1]
			var rotation: int = adj[2]
			var back: Array = SphereRhomboTopology.ADJACENCY[to_face][to_edge]
			assert_eq(back[0], face, "%s %s back face" % [face, edge])
			assert_eq(back[1], edge, "%s %s back edge" % [face, edge])
			assert_eq((rotation + int(back[2])) % 4, 0, "%s %s rotation sum" % [face, edge])

func test_sphere_rhombo_wrap_step_grid_adjacent() -> void:
	# Stepping east off +Z lands on eS without identification (grid-adjacent).
	var sphere := SphereRhomboTopology.new()
	var face_side: float = SphereRhomboTopology.FACE_SIDE
	# +Z is at slot (2, 3); xMax = 2*face_side - 4*face_side = -2*face_side ...
	# easier: spawn at +Z center, step east a small overshoot past xMax.
	var ext_x: float = sphere.extent_x()
	var z_center: float = 0.0
	# +Z center x in world: (2 + 0.5)*face_side - ext_x/2.
	var pz_center_x: float = 2.5 * face_side - ext_x * 0.5
	var prev := Vector3(pz_center_x + face_side * 0.4, 0.0, z_center)
	var next := Vector3(pz_center_x + face_side * 0.6, 0.0, z_center)
	var out := sphere.wrap_step(prev, next)
	# Result should sit inside eS (which is at slot (3, 3)). eS center x =
	# 3.5*face_side - ext_x/2.
	var es_center_x: float = 3.5 * face_side - ext_x * 0.5
	assert_true(absf(out.x - es_center_x) < face_side, "wrap_step landed inside eS")
	assert_approx(out.z, z_center, 0.01, "wrap_step preserved z on grid-adjacent step")

func test_sphere_rhombo_wrap_step_equator_seam() -> void:
	# Stepping west off -X wraps around the equator to eL (the east side of
	# eL). Equator wrap is rotation 0 / no parameter flip.
	var sphere := SphereRhomboTopology.new()
	var face_side: float = SphereRhomboTopology.FACE_SIDE
	var ext_x: float = sphere.extent_x()
	# -X is at slot (0, 3); xMin = -ext_x/2.
	var nx_center_x: float = 0.5 * face_side - ext_x * 0.5
	var prev := Vector3(nx_center_x - face_side * 0.4, 0.0, 0.0)
	var next := Vector3(nx_center_x - face_side * 0.6, 0.0, 0.0)
	var out := sphere.wrap_step(prev, next)
	# eL is at slot (7, 3); eL xMin = 7*face_side - ext_x/2.
	var el_xmin: float = 7.0 * face_side - ext_x * 0.5
	var el_xmax: float = el_xmin + face_side
	assert_true(out.x >= el_xmin and out.x < el_xmax, "wrap_step wrapped onto eL: x=%f" % out.x)

func test_sphere_rhombo_wrap_step_cap_identification() -> void:
	# Stepping north off +X identifies to ePYe via the cap-edge rule.
	var sphere := SphereRhomboTopology.new()
	var face_side: float = SphereRhomboTopology.FACE_SIDE
	var ext_x: float = sphere.extent_x()
	var ext_z: float = sphere.extent_z()
	# +X is at slot (4, 3); +X north edge is at z = ext_z/2 - 3*face_side.
	var px_center_x: float = 4.5 * face_side - ext_x * 0.5
	var px_zmax: float = ext_z * 0.5 - 3.0 * face_side
	var prev := Vector3(px_center_x, 0.0, px_zmax - face_side * 0.1)
	var next := Vector3(px_center_x, 0.0, px_zmax + face_side * 0.2)
	var out := sphere.wrap_step(prev, next)
	# ePYe is at slot (3, 1). Its world rect: xMin = 3*face_side - ext_x/2,
	# xMax = xMin + face_side, zMax = ext_z/2 - face_side, zMin = zMax - face_side.
	var ePYe_xmin: float = 3.0 * face_side - ext_x * 0.5
	var ePYe_xmax: float = ePYe_xmin + face_side
	var ePYe_zmax: float = ext_z * 0.5 - face_side
	var ePYe_zmin: float = ePYe_zmax - face_side
	assert_true(
		out.x >= ePYe_xmin and out.x < ePYe_xmax,
		"wrap_step landed in ePYe x range: x=%f range=[%f,%f]" % [out.x, ePYe_xmin, ePYe_xmax],
	)
	assert_true(
		out.z >= ePYe_zmin and out.z < ePYe_zmax,
		"wrap_step landed in ePYe z range: z=%f range=[%f,%f]" % [out.z, ePYe_zmin, ePYe_zmax],
	)

func test_sphere_rhombo_wrap_step_clears_perpendicular_wall() -> void:
	# Repro for the polyhedron-vertex bounce trap. Crossing -X.south near
	# its SW corner identifies to eNYw.west near its south end. eNYw has a
	# south perimeter wall (no walkable adjacency through the triangle
	# at t-x-y-z). Without the safe-nudge, the destination lands at
	# exactly WALL_CLEARANCE from that wall and IEEE-754 rounding pins
	# the player there. The destination must clear the perpendicular wall
	# by at least WALL_CLEARANCE so the next tick can collision-check from
	# a position that isn't already inside clearance.
	var sphere := SphereRhomboTopology.new()
	var face_side: float = SphereRhomboTopology.FACE_SIDE
	var ext_x: float = sphere.extent_x()
	var ext_z: float = sphere.extent_z()
	var nx_xmin: float = -ext_x * 0.5
	var nx_zmin: float = ext_z * 0.5 - 4.0 * face_side
	var prev := Vector3(nx_xmin + 0.6, 0.0, nx_zmin + 0.02)
	var next := Vector3(nx_xmin + 0.5, 0.0, nx_zmin - 0.04)
	var out := sphere.wrap_step(prev, next)
	# eNYw at slot (1, 5); its south wall lives at z = eNYw_zmin.
	var eNYw_zmin: float = ext_z * 0.5 - 6.0 * face_side
	# eNYw_zmin = halfZ - 6*faceSide. With halfZ=35 and faceSide=10, that's -25.
	var distance_to_south_wall: float = out.z - eNYw_zmin
	assert_true(
		distance_to_south_wall >= SphereRhomboTopology.SPHERE_WALL_CLEARANCE,
		"wrap_step destination clears the south perimeter wall: dist=%f required>=%f"
			% [distance_to_south_wall, SphereRhomboTopology.SPHERE_WALL_CLEARANCE],
	)

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

func test_factory_returns_correct_kind() -> void:
	assert_eq(TopologyFactory.from_string("plane").kind(), TopologyScript.Kind.PLANE)
	assert_eq(TopologyFactory.from_string("torus").kind(), TopologyScript.Kind.TORUS)
	assert_eq(TopologyFactory.from_string("klein").kind(), TopologyScript.Kind.KLEIN)
	assert_eq(TopologyFactory.from_string("sphere").kind(), TopologyScript.Kind.SPHERE)
	assert_eq(TopologyFactory.from_string("genus2").kind(), TopologyScript.Kind.GENUS2)
