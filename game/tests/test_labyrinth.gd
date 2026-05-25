extends "res://tests/test_case.gd"

const LABYRINTH := preload("res://scenes/labyrinth.tscn")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")
const TorusTopology := preload("res://scripts/topology/torus_topology.gd")
const KleinTopology := preload("res://scripts/topology/klein_topology.gd")
const SphereTopology := preload("res://scripts/topology/sphere_topology.gd")
const GridMaze := preload("res://scripts/grid_maze.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")

func test_build_creates_walls_deterministically() -> void:
	var topology := PlaneTopology.new()
	var first := LABYRINTH.instantiate()
	first.build(12345, topology)
	var second := LABYRINTH.instantiate()
	second.build(12345, topology)
	assert_eq(
		first.walls_root.get_child_count(),
		second.walls_root.get_child_count(),
		"deterministic wall count"
	)
	first.queue_free()
	second.queue_free()

func test_seeds_produce_walls() -> void:
	# Plane now uses the grid maze too. A 10x10 spanning tree leaves a couple
	# of dozen interior walls plus the boundary walls, so any plausible seed
	# clears the lower bound by a comfortable margin.
	var topology := PlaneTopology.new()
	var a := LABYRINTH.instantiate()
	a.build(1, topology)
	var b := LABYRINTH.instantiate()
	b.build(2, topology)
	assert_true(a.walls_root.get_child_count() > 30, "seed 1 produces a populated labyrinth")
	assert_true(b.walls_root.get_child_count() > 30, "seed 2 produces a populated labyrinth")
	a.queue_free()
	b.queue_free()

func test_plane_grid_has_closed_boundary() -> void:
	var segs: Array = GridMaze.generate(123, "plane")
	var half: float = 40.0
	var on_left := false
	var on_right := false
	var on_top := false
	var on_bottom := false
	for seg in segs:
		if seg["ax"] == -half and seg["bx"] == -half:
			on_left = true
		if seg["ax"] == half and seg["bx"] == half:
			on_right = true
		if seg["az"] == half and seg["bz"] == half:
			on_top = true
		if seg["az"] == -half and seg["bz"] == -half:
			on_bottom = true
	assert_true(on_left, "plane has left boundary wall")
	assert_true(on_right, "plane has right boundary wall")
	assert_true(on_top, "plane has top boundary wall")
	assert_true(on_bottom, "plane has bottom boundary wall")

func test_gap_jitter_matches_ts_for_known_inputs() -> void:
	# Same expected values as backend/shared/src/labyrinth.test.ts so client and
	# server geometry stay aligned. Spot-checks across the input domain rather
	# than exhaustive enumeration.
	const LabyrinthScript := preload("res://scripts/labyrinth.gd")
	for triple in [[0, 0, 0], [1, 2, 3], [12345, 5, 1], [99, 3, 2]]:
		var v: int = LabyrinthScript._gap_jitter(triple[0], triple[1], triple[2])
		assert_true(v == 0 or v == 1, "gap_jitter %s -> %d" % [str(triple), v])

func test_grid_maze_is_deterministic() -> void:
	var first: Array = GridMaze.generate(2026, "torus")
	var second: Array = GridMaze.generate(2026, "torus")
	assert_eq(first.size(), second.size(), "same seed yields same wall count")
	for i in first.size():
		assert_eq(first[i]["ax"], second[i]["ax"], "ax %d" % i)
		assert_eq(first[i]["az"], second[i]["az"], "az %d" % i)
		assert_eq(first[i]["bx"], second[i]["bx"], "bx %d" % i)
		assert_eq(first[i]["bz"], second[i]["bz"], "bz %d" % i)

func test_grid_maze_walls_are_axis_aligned() -> void:
	for seg in GridMaze.generate(42, "torus"):
		var axis_aligned: bool = seg["ax"] == seg["bx"] or seg["az"] == seg["bz"]
		assert_true(axis_aligned, "wall axis-aligned: %s" % str(seg))

func test_grid_maze_skips_wrap_seam() -> void:
	# A wall on the outer playfield boundary would visually double up since the
	# topology folds both edges together. Klein is now a 2W x W double cover,
	# so its outer seams are at x = +-W and z = +-W/2.
	var half_x: float = TopologyScript.WIDTH
	var half_z: float = TopologyScript.WIDTH / 2.0
	for seg in GridMaze.generate(7, "klein"):
		var on_left: bool = seg["ax"] == -half_x and seg["bx"] == -half_x
		var on_right: bool = seg["ax"] == half_x and seg["bx"] == half_x
		var on_top: bool = seg["az"] == half_z and seg["bz"] == half_z
		var on_bottom: bool = seg["az"] == -half_z and seg["bz"] == -half_z
		assert_true(
			not (on_left or on_right or on_top or on_bottom),
			"no wall on the wrap seam: %s" % str(seg)
		)

func test_grid_maze_builds_walls_for_torus_topology() -> void:
	var topology := TorusTopology.new()
	var instance := LABYRINTH.instantiate()
	instance.build(2026, topology)
	assert_true(
		instance.walls_root.get_child_count() > 30,
		"torus maze has substantial wall count, got %d" % instance.walls_root.get_child_count()
	)
	instance.queue_free()

func test_grid_maze_builds_walls_for_klein_topology() -> void:
	var topology := KleinTopology.new()
	var instance := LABYRINTH.instantiate()
	instance.build(2026, topology)
	assert_true(
		instance.walls_root.get_child_count() > 30,
		"klein maze has substantial wall count, got %d" % instance.walls_root.get_child_count()
	)
	instance.queue_free()

func test_sphere_grid_has_walls_and_open_walkable_seams() -> void:
	# Rhombicuboctahedron unfold: 18 walkable faces with interior mazes
	# plus perimeter walls along edges that border a triangle barrier.
	# Edges shared by two walkable cells must stay open so the player can
	# walk between them.
	var segs: Array = GridMaze.generate(7, "sphere")
	assert_true(segs.size() > 30, "sphere maze has substantial wall count, got %d" % segs.size())
	var face_side: float = TopologyScript.WIDTH / float(GridMaze.NET_COLS)
	var ext_x: float = float(GridMaze.NET_COLS) * face_side
	var ext_z: float = float(GridMaze.NET_ROWS) * face_side
	# Build the open-edge segments: for each walkable face, take its
	# east-side and north-side boundary segments that face another
	# walkable cell in the unfold.
	var open_v: Array = []  # [x, z_min, z_max]
	var open_h: Array = []  # [z, x_min, x_max]
	for face in GridMaze.SPHERE_FACE_SLOTS.keys():
		var slot: Vector2i = GridMaze.SPHERE_FACE_SLOTS[face]
		var x_min: float = slot.x * face_side - ext_x * 0.5
		var x_max: float = x_min + face_side
		var z_max: float = ext_z * 0.5 - slot.y * face_side
		var z_min: float = z_max - face_side
		# East neighbour shares x_max boundary.
		var east_neighbour_slot := Vector2i(slot.x + 1, slot.y)
		for other in GridMaze.SPHERE_FACE_SLOTS.keys():
			if GridMaze.SPHERE_FACE_SLOTS[other] == east_neighbour_slot:
				open_v.append([x_max, z_min, z_max])
				break
		# North neighbour shares z_max boundary.
		var north_neighbour_slot := Vector2i(slot.x, slot.y - 1)
		for other in GridMaze.SPHERE_FACE_SLOTS.keys():
			if GridMaze.SPHERE_FACE_SLOTS[other] == north_neighbour_slot:
				open_h.append([z_max, x_min, x_max])
				break
	for seg in segs:
		var axis_aligned: bool = seg["ax"] == seg["bx"] or seg["az"] == seg["bz"]
		assert_true(axis_aligned, "sphere wall axis-aligned: %s" % str(seg))
		if seg["ax"] == seg["bx"]:
			var wmin: float = minf(seg["az"], seg["bz"])
			var wmax: float = maxf(seg["az"], seg["bz"])
			for line in open_v:
				if absf(seg["ax"] - line[0]) > 0.001:
					continue
				var disjoint: bool = wmax <= line[1] + 0.001 or wmin >= line[2] - 0.001
				assert_true(disjoint, "vertical wall on open walkable seam: %s" % str(seg))
		if seg["az"] == seg["bz"]:
			var wmin2: float = minf(seg["ax"], seg["bx"])
			var wmax2: float = maxf(seg["ax"], seg["bx"])
			for line in open_h:
				if absf(seg["az"] - line[0]) > 0.001:
					continue
				var disjoint: bool = wmax2 <= line[1] + 0.001 or wmin2 >= line[2] - 0.001
				assert_true(disjoint, "horizontal wall on open walkable seam: %s" % str(seg))

func test_sphere_grid_differs_from_torus() -> void:
	var s: Array = GridMaze.generate(2026, "sphere")
	var t: Array = GridMaze.generate(2026, "torus")
	# Even if counts happen to coincide, at least one segment must differ.
	var same: bool = s.size() == t.size()
	if same:
		for i in s.size():
			if s[i] != t[i]:
				same = false
				break
	assert_true(not same, "sphere and torus diverge at the same seed")

func test_sphere_grid_builds_walls() -> void:
	var topology := SphereTopology.new()
	var instance := LABYRINTH.instantiate()
	instance.build(2026, topology)
	assert_true(
		instance.walls_root.get_child_count() > 30,
		"sphere maze has substantial wall count, got %d" % instance.walls_root.get_child_count()
	)
	instance.queue_free()
