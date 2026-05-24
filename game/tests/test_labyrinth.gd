extends "res://tests/test_case.gd"

const LABYRINTH := preload("res://scenes/labyrinth.tscn")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")
const TorusTopology := preload("res://scripts/topology/torus_topology.gd")
const KleinTopology := preload("res://scripts/topology/klein_topology.gd")
const GridMaze := preload("res://scripts/grid_maze.gd")

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
	var topology := PlaneTopology.new()
	var a := LABYRINTH.instantiate()
	a.build(1, topology)
	var b := LABYRINTH.instantiate()
	b.build(2, topology)
	assert_true(a.walls_root.get_child_count() > 100, "seed 1 produces a populated labyrinth")
	assert_true(b.walls_root.get_child_count() > 100, "seed 2 produces a populated labyrinth")
	a.queue_free()
	b.queue_free()

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
	# A wall on x=+-half or z=+-half would visually double up since the
	# topology folds both edges together. The generator must never emit one.
	var half: float = 40.0
	for seg in GridMaze.generate(7, "klein"):
		var on_left: bool = seg["ax"] == -half and seg["bx"] == -half
		var on_right: bool = seg["ax"] == half and seg["bx"] == half
		var on_top: bool = seg["az"] == half and seg["bz"] == half
		var on_bottom: bool = seg["az"] == -half and seg["bz"] == -half
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
