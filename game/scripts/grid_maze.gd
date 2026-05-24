extends RefCounted

## Wrap-aware grid maze generator. Mirrors backend/shared/src/gridMaze.ts
## bit-for-bit (same LCG, same neighbor traversal order) so client and server
## arrive at the same wall list from the same (seed, topology, grid_n).
##
## Returns an array of dicts: {ax, az, bx, bz} matching the WallSegment shape
## the rest of the labyrinth code expects.

const GRID_MAZE_N := 10
const DIR_EAST := 0
const DIR_NORTH := 1
const DIR_WEST := 2
const DIR_SOUTH := 3

const TopologyScript := preload("res://scripts/topology/topology.gd")

static func generate(seed_value: int, topology_name: String, grid_n: int = GRID_MAZE_N) -> Array:
	if topology_name != "torus" and topology_name != "klein":
		return []
	var total: int = grid_n * grid_n
	var visited := PackedByteArray()
	visited.resize(total)
	var openings := PackedByteArray()
	openings.resize(total)
	var rng_state: int = seed_value & 0xFFFFFFFF
	# Burn one draw to match the TS implementation which calls next() once for
	# the starting cell.
	rng_state = _lcg_next(rng_state)
	var start: int = rng_state % total
	visited[start] = 1
	var stack: Array[int] = [start]
	while not stack.is_empty():
		var cur: int = stack[stack.size() - 1]
		var candidates: Array = []
		for dir in 4:
			var nb: int = _neighbor_of(cur, dir, grid_n, topology_name)
			if nb < 0:
				continue
			if visited[nb] != 0:
				continue
			candidates.append([dir, nb])
		if candidates.is_empty():
			stack.pop_back()
			continue
		rng_state = _lcg_next(rng_state)
		var pick: Array = candidates[rng_state % candidates.size()]
		var pick_dir: int = pick[0]
		var pick_cell: int = pick[1]
		openings[cur] = openings[cur] | (1 << pick_dir)
		openings[pick_cell] = openings[pick_cell] | (1 << _opposite(pick_dir))
		visited[pick_cell] = 1
		stack.append(pick_cell)
	return _emit_walls(openings, grid_n)

static func _opposite(dir: int) -> int:
	return (dir + 2) % 4

static func _lcg_next(state: int) -> int:
	return ((state * 1664525) + 1013904223) & 0xFFFFFFFF

static func _neighbor_of(cell: int, dir: int, grid_n: int, topology_name: String) -> int:
	var cc: int = cell % grid_n
	var cr: int = cell / grid_n
	var nc: int = cc
	var nr: int = cr
	var flip_row: bool = false
	if dir == DIR_EAST:
		nc = cc + 1
	elif dir == DIR_WEST:
		nc = cc - 1
	elif dir == DIR_NORTH:
		nr = cr + 1
	elif dir == DIR_SOUTH:
		nr = cr - 1
	if nc < 0 or nc >= grid_n:
		nc = ((nc % grid_n) + grid_n) % grid_n
		if topology_name == "klein":
			flip_row = true
	if nr < 0 or nr >= grid_n:
		nr = ((nr % grid_n) + grid_n) % grid_n
	if flip_row:
		nr = grid_n - 1 - nr
	return nc + nr * grid_n

static func _emit_walls(openings: PackedByteArray, grid_n: int) -> Array:
	var cell: float = TopologyScript.WIDTH / float(grid_n)
	var half: float = TopologyScript.WIDTH / 2.0
	var out: Array = []
	for r in grid_n:
		for c in grid_n:
			var id: int = c + r * grid_n
			var is_last_col: bool = c == grid_n - 1
			var is_last_row: bool = r == grid_n - 1
			var east_closed: bool = (openings[id] & (1 << DIR_EAST)) == 0
			var north_closed: bool = (openings[id] & (1 << DIR_NORTH)) == 0
			if east_closed and not is_last_col:
				var x: float = (float(c + 1) * cell) - half
				var z0: float = (float(r) * cell) - half
				var z1: float = (float(r + 1) * cell) - half
				out.append({"ax": x, "az": z0, "bx": x, "bz": z1})
			if north_closed and not is_last_row:
				var z: float = (float(r + 1) * cell) - half
				var x0: float = (float(c) * cell) - half
				var x1: float = (float(c + 1) * cell) - half
				out.append({"ax": x0, "az": z, "bx": x1, "bz": z})
	return out
