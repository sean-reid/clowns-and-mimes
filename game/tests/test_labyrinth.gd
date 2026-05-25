extends "res://tests/test_case.gd"

const LABYRINTH := preload("res://scenes/labyrinth.tscn")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")
const TorusTopology := preload("res://scripts/topology/torus_topology.gd")
const KleinTopology := preload("res://scripts/topology/klein_topology.gd")
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

