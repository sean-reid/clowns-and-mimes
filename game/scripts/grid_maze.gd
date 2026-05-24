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
	if topology_name == "sphere":
		# Sphere still uses concentric rings pending a real cube-mapped
		# topology. Callers fall back to ring generation when this is empty.
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
	rng_state = _braid(openings, grid_n, topology_name, rng_state)
	return _emit_walls(openings, grid_n, topology_name)

# Knock down one wall per dead-end cell so the labyrinth has loops rather than
# terminal branches. Mirrors backend/shared/src/gridMaze.ts::braid and uses the
# same LCG state so client and server end up with identical opening sets.
static func _braid(openings: PackedByteArray, grid_n: int, topology_name: String, rng_state: int) -> int:
	var total: int = grid_n * grid_n
	for cell in total:
		if _popcount_nibble(openings[cell]) >= 2:
			continue
		var closed_neighbors: Array = []
		for dir in 4:
			if (openings[cell] & (1 << dir)) != 0:
				continue
			var nb: int = _neighbor_of(cell, dir, grid_n, topology_name)
			if nb < 0:
				continue
			closed_neighbors.append([dir, nb])
		if closed_neighbors.is_empty():
			continue
		rng_state = _lcg_next(rng_state)
		var pick: Array = closed_neighbors[rng_state % closed_neighbors.size()]
		var pick_dir: int = pick[0]
		var pick_cell: int = pick[1]
		openings[cell] = openings[cell] | (1 << pick_dir)
		openings[pick_cell] = openings[pick_cell] | (1 << _opposite(pick_dir))
	return rng_state

static func _popcount_nibble(byte: int) -> int:
	var n: int = byte & 0xf
	n = (n & 0x5) + ((n >> 1) & 0x5)
	n = (n & 0x3) + ((n >> 2) & 0x3)
	return n

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
		if topology_name == "plane":
			return -1
		nc = ((nc % grid_n) + grid_n) % grid_n
		if topology_name == "klein":
			flip_row = true
	if nr < 0 or nr >= grid_n:
		if topology_name == "plane":
			return -1
		nr = ((nr % grid_n) + grid_n) % grid_n
	if flip_row:
		nr = grid_n - 1 - nr
	return nc + nr * grid_n

static func _emit_walls(openings: PackedByteArray, grid_n: int, topology_name: String) -> Array:
	var cell: float = TopologyScript.WIDTH / float(grid_n)
	var half: float = TopologyScript.WIDTH / 2.0
	var out: Array = []
	var closed_boundary: bool = topology_name == "plane"
	for r in grid_n:
		for c in grid_n:
			var id: int = c + r * grid_n
			var is_last_col: bool = c == grid_n - 1
			var is_last_row: bool = r == grid_n - 1
			var east_closed: bool = (openings[id] & (1 << DIR_EAST)) == 0
			var north_closed: bool = (openings[id] & (1 << DIR_NORTH)) == 0
			if east_closed and (not is_last_col or closed_boundary):
				var x: float = (float(c + 1) * cell) - half
				var z0: float = (float(r) * cell) - half
				var z1: float = (float(r + 1) * cell) - half
				out.append({"ax": x, "az": z0, "bx": x, "bz": z1})
			if north_closed and (not is_last_row or closed_boundary):
				var z: float = (float(r + 1) * cell) - half
				var x0: float = (float(c) * cell) - half
				var x1: float = (float(c + 1) * cell) - half
				out.append({"ax": x0, "az": z, "bx": x1, "bz": z})
	# Plane needs the west and south boundary walls; the east+north loop above
	# can never emit them since those edges have no cell to own them.
	if closed_boundary:
		for r in grid_n:
			var z0: float = (float(r) * cell) - half
			var z1: float = (float(r + 1) * cell) - half
			out.append({"ax": -half, "az": z0, "bx": -half, "bz": z1})
		for c in grid_n:
			var x0: float = (float(c) * cell) - half
			var x1: float = (float(c + 1) * cell) - half
			out.append({"ax": x0, "az": -half, "bx": x1, "bz": -half})
	return out
