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

# Sphere cube-face layout. Six 4x6 mazes packed 3x2 fill the playfield. The
# constants match backend/shared/src/gridMaze.ts so the TS server and the
# GDScript client agree on every wall.
const SPHERE_FACE_COLS := 3
const SPHERE_FACE_ROWS := 2
const SPHERE_FACE_CELLS_X := 4
const SPHERE_FACE_CELLS_Z := 6
const SPHERE_GRID_X := SPHERE_FACE_COLS * SPHERE_FACE_CELLS_X  # 12
const SPHERE_GRID_Z := SPHERE_FACE_ROWS * SPHERE_FACE_CELLS_Z  # 12

const TopologyScript := preload("res://scripts/topology/topology.gd")

static func generate(seed_value: int, topology_name: String, grid_n: int = GRID_MAZE_N) -> Array:
	if topology_name == "sphere":
		return _generate_sphere(seed_value)
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

# Sphere wall list: six independent grid mazes laid out 3x2 in the playfield.
# Each face is a 4x6 cell grid. Face boundaries carry no walls so a player
# crossing a face edge wraps onto the adjacent face via the topology adapter.
#
# Faces are visited in a fixed order (row 0 col 0, row 0 col 1, row 0 col 2,
# row 1 col 0, row 1 col 1, row 1 col 2) and share one LCG state, mirroring
# backend/shared/src/gridMaze.ts::generateSphereGridWalls.
#
# TODO: this first cut uses torus-like wrapping between faces. Proper cube-net
# edge rotations and per-face spawn zones are a follow-up.
static func _generate_sphere(seed_value: int) -> Array:
	var fcx: int = SPHERE_FACE_CELLS_X
	var fcz: int = SPHERE_FACE_CELLS_Z
	var face_total: int = fcx * fcz
	var total_cells: int = SPHERE_GRID_X * SPHERE_GRID_Z
	var openings := PackedByteArray()
	openings.resize(total_cells)
	var rng_state: int = seed_value & 0xFFFFFFFF
	for fr in SPHERE_FACE_ROWS:
		for fc in SPHERE_FACE_COLS:
			var local_visited := PackedByteArray()
			local_visited.resize(face_total)
			var local_openings := PackedByteArray()
			local_openings.resize(face_total)
			rng_state = _lcg_next(rng_state)
			var start: int = rng_state % face_total
			local_visited[start] = 1
			var stack: Array[int] = [start]
			while not stack.is_empty():
				var cur: int = stack[stack.size() - 1]
				var candidates: Array = []
				for dir in 4:
					var nb: int = _sphere_local_neighbor(cur, dir, fcx, fcz)
					if nb < 0:
						continue
					if local_visited[nb] != 0:
						continue
					candidates.append([dir, nb])
				if candidates.is_empty():
					stack.pop_back()
					continue
				rng_state = _lcg_next(rng_state)
				var pick: Array = candidates[rng_state % candidates.size()]
				var pick_dir: int = pick[0]
				var pick_cell: int = pick[1]
				local_openings[cur] = local_openings[cur] | (1 << pick_dir)
				local_openings[pick_cell] = local_openings[pick_cell] | (1 << _opposite(pick_dir))
				local_visited[pick_cell] = 1
				stack.append(pick_cell)
			# Per-face braid using the shared LCG state.
			for cell in face_total:
				if _popcount_nibble(local_openings[cell]) >= 2:
					continue
				var closed_neighbors: Array = []
				for dir in 4:
					if (local_openings[cell] & (1 << dir)) != 0:
						continue
					var nb: int = _sphere_local_neighbor(cell, dir, fcx, fcz)
					if nb < 0:
						continue
					closed_neighbors.append([dir, nb])
				if closed_neighbors.is_empty():
					continue
				rng_state = _lcg_next(rng_state)
				var pick: Array = closed_neighbors[rng_state % closed_neighbors.size()]
				var pick_dir: int = pick[0]
				var pick_cell: int = pick[1]
				local_openings[cell] = local_openings[cell] | (1 << pick_dir)
				local_openings[pick_cell] = local_openings[pick_cell] | (1 << _opposite(pick_dir))
			# Copy this face's openings into the 12x12 global packing.
			for lr in fcz:
				for lc in fcx:
					var gc: int = fc * fcx + lc
					var gr: int = fr * fcz + lr
					openings[gc + gr * SPHERE_GRID_X] = local_openings[lc + lr * fcx]
	return _emit_sphere_walls(openings)

static func _sphere_local_neighbor(local_cell: int, dir: int, fcx: int, fcz: int) -> int:
	var lc: int = local_cell % fcx
	var lr: int = local_cell / fcx
	var nc: int = lc
	var nr: int = lr
	if dir == DIR_EAST:
		nc = lc + 1
	elif dir == DIR_WEST:
		nc = lc - 1
	elif dir == DIR_NORTH:
		nr = lr + 1
	elif dir == DIR_SOUTH:
		nr = lr - 1
	if nc < 0 or nc >= fcx:
		return -1
	if nr < 0 or nr >= fcz:
		return -1
	return nc + nr * fcx

static func _emit_sphere_walls(openings: PackedByteArray) -> Array:
	var cell: float = TopologyScript.WIDTH / float(SPHERE_GRID_X)
	var half: float = TopologyScript.WIDTH / 2.0
	var fcx: int = SPHERE_FACE_CELLS_X
	var fcz: int = SPHERE_FACE_CELLS_Z
	var out: Array = []
	for r in SPHERE_GRID_Z:
		for c in SPHERE_GRID_X:
			var id: int = c + r * SPHERE_GRID_X
			var east_closed: bool = (openings[id] & (1 << DIR_EAST)) == 0
			var north_closed: bool = (openings[id] & (1 << DIR_NORTH)) == 0
			var local_col: int = c % fcx
			var local_row: int = r % fcz
			var on_face_east_edge: bool = local_col == fcx - 1
			var on_face_north_edge: bool = local_row == fcz - 1
			if east_closed and not on_face_east_edge:
				var x: float = (float(c + 1) * cell) - half
				var z0: float = (float(r) * cell) - half
				var z1: float = (float(r + 1) * cell) - half
				out.append({"ax": x, "az": z0, "bx": x, "bz": z1})
			if north_closed and not on_face_north_edge:
				var z: float = (float(r + 1) * cell) - half
				var x0: float = (float(c) * cell) - half
				var x1: float = (float(c + 1) * cell) - half
				out.append({"ax": x0, "az": z, "bx": x1, "bz": z})
	return out
