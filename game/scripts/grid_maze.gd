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
	if topology_name == "klein":
		return _generate_klein(seed_value, grid_n)
	if topology_name == "genus2":
		return _generate_genus2(seed_value)
	if topology_name == "mobius":
		return _generate_mobius(seed_value)
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

# Klein wall list as the double cover of an NxN fundamental klein maze.
# Mirrors backend/shared/src/gridMaze.ts::generateKleinGridWalls. The
# fundamental maze uses the klein flip-row wrap; we unfold it into a 2N x N
# grid where the right half is the z-mirror of the left so the bottle's
# z-orientation flip is walkable space, not an instant teleport at the seam.
static func _generate_klein(seed_value: int, grid_n: int) -> Array:
	var fundamental: PackedByteArray = _build_fundamental_klein_openings(seed_value, grid_n)
	var cols: int = 2 * grid_n
	var rows: int = grid_n
	var expanded := PackedByteArray()
	expanded.resize(cols * rows)
	for r in rows:
		for c in grid_n:
			# Left half: identity copy.
			expanded[c + r * cols] = fundamental[c + r * grid_n]
			# Right half: z-mirror of the fundamental at row N-1-r, with
			# NORTH<->SOUTH swapped on the cell mask.
			var src: int = fundamental[c + (rows - 1 - r) * grid_n]
			expanded[grid_n + c + r * cols] = _swap_north_south(src)
	return _emit_klein_expanded_walls(expanded, grid_n)

static func _build_fundamental_klein_openings(seed_value: int, grid_n: int) -> PackedByteArray:
	var total: int = grid_n * grid_n
	var visited := PackedByteArray()
	visited.resize(total)
	var openings := PackedByteArray()
	openings.resize(total)
	var rng_state: int = seed_value & 0xFFFFFFFF
	rng_state = _lcg_next(rng_state)
	var start: int = rng_state % total
	visited[start] = 1
	var stack: Array[int] = [start]
	while not stack.is_empty():
		var cur: int = stack[stack.size() - 1]
		var candidates: Array = []
		for dir in 4:
			var nb: int = _neighbor_of(cur, dir, grid_n, "klein")
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
	rng_state = _braid(openings, grid_n, "klein", rng_state)
	return openings

static func _swap_north_south(mask: int) -> int:
	var east: int = mask & (1 << DIR_EAST)
	var north: int = mask & (1 << DIR_NORTH)
	var west: int = mask & (1 << DIR_WEST)
	var south: int = mask & (1 << DIR_SOUTH)
	var out: int = east | west
	if north != 0:
		out = out | (1 << DIR_SOUTH)
	if south != 0:
		out = out | (1 << DIR_NORTH)
	return out

static func _emit_klein_expanded_walls(openings: PackedByteArray, grid_n: int) -> Array:
	var cols: int = 2 * grid_n
	var rows: int = grid_n
	var cell: float = TopologyScript.WIDTH / float(grid_n)
	# Double cover spans x in [-WIDTH, WIDTH] and z in [-WIDTH/2, WIDTH/2].
	var half_x: float = TopologyScript.WIDTH
	var half_z: float = TopologyScript.WIDTH / 2.0
	var out: Array = []
	for r in rows:
		for c in cols:
			var id: int = c + r * cols
			var is_last_col: bool = c == cols - 1
			var is_last_row: bool = r == rows - 1
			var east_closed: bool = (openings[id] & (1 << DIR_EAST)) == 0
			var north_closed: bool = (openings[id] & (1 << DIR_NORTH)) == 0
			if east_closed and not is_last_col:
				var x: float = (float(c + 1) * cell) - half_x
				var z0: float = (float(r) * cell) - half_z
				var z1: float = (float(r + 1) * cell) - half_z
				out.append({"ax": x, "az": z0, "bx": x, "bz": z1})
			if north_closed and not is_last_row:
				var z: float = (float(r + 1) * cell) - half_z
				var x0: float = (float(c) * cell) - half_x
				var x1: float = (float(c + 1) * cell) - half_x
				out.append({"ax": x0, "az": z, "bx": x1, "bz": z})
	return out

# Genus-2 (double torus) maze. A square N x N grid is inscribed in the
# octagon's bounding box; cells whose centres fall outside the octagon
# are masked out. DFS spanning tree + braiding runs only on the walkable
# cells. Mirrors backend/shared/src/gridMaze.ts::generateGenus2GridWalls,
# matching the seed -> wall list deterministically.
const GENUS2_GRID_N := 12
const GENUS2_OCTAGON_CIRCUMRADIUS := 40.0

static func _genus2_point_in_octagon(x: float, z: float) -> bool:
	# Point is inside the octagon iff cos(theta_k) * x + sin(theta_k) * z <
	# R * cos(22.5 deg) for every side k (the inscribed-circle radius).
	# Equivalent and slightly simpler: signed distance to every side is <= 0.
	# Use a direct check against the 8 side outward normals.
	var r: float = GENUS2_OCTAGON_CIRCUMRADIUS
	for k in range(8):
		var theta_v0: float = PI / 4.0 * float(k)
		var theta_v1: float = PI / 4.0 * float(k + 1)
		var v0x: float = cos(theta_v0) * r
		var v0z: float = sin(theta_v0) * r
		var v1x: float = cos(theta_v1) * r
		var v1z: float = sin(theta_v1) * r
		var length: float = sqrt((v1x - v0x) * (v1x - v0x) + (v1z - v0z) * (v1z - v0z))
		var tx: float = (v1x - v0x) / length
		var tz: float = (v1z - v0z) / length
		# Outward normal = tangent rotated -90 deg: (tx, tz) -> (tz, -tx).
		var nx: float = tz
		var nz: float = -tx
		var signed_d: float = (x - v0x) * nx + (z - v0z) * nz
		if signed_d > 1e-9:
			return false
	return true

static func _generate_genus2(seed_value: int) -> Array:
	var n: int = GENUS2_GRID_N
	var total: int = n * n
	var cell_size: float = 2.0 * GENUS2_OCTAGON_CIRCUMRADIUS / float(n)
	var half_ext: float = GENUS2_OCTAGON_CIRCUMRADIUS

	var walkable := PackedByteArray()
	walkable.resize(total)
	for r in range(n):
		for c in range(n):
			var cx: float = (float(c) + 0.5) * cell_size - half_ext
			var cz: float = (float(r) + 0.5) * cell_size - half_ext
			walkable[c + r * n] = 1 if _genus2_point_in_octagon(cx, cz) else 0

	var rng_state: int = seed_value & 0xFFFFFFFF
	var visited := PackedByteArray()
	visited.resize(total)
	var openings := PackedByteArray()
	openings.resize(total)

	var start: int = -1
	for i in range(total):
		if walkable[i] != 0:
			start = i
			break
	if start < 0:
		return []
	visited[start] = 1
	var stack: Array[int] = [start]
	while not stack.is_empty():
		var cur: int = stack[stack.size() - 1]
		var candidates: Array = []
		for dir in 4:
			var nb: int = _genus2_neighbor(cur, dir, n, walkable)
			if nb < 0:
				continue
			if visited[nb] != 0:
				continue
			candidates.append(dir)
		if candidates.is_empty():
			stack.pop_back()
			continue
		rng_state = _lcg_next(rng_state)
		var pick_dir: int = candidates[rng_state % candidates.size()]
		var nb_idx: int = _genus2_neighbor(cur, pick_dir, n, walkable)
		openings[cur] = openings[cur] | (1 << pick_dir)
		openings[nb_idx] = openings[nb_idx] | (1 << _opposite(pick_dir))
		visited[nb_idx] = 1
		stack.append(nb_idx)

	# Braid dead ends.
	for cell in range(total):
		if walkable[cell] == 0:
			continue
		if _popcount_nibble(openings[cell]) >= 2:
			continue
		var closed_neighbors: Array = []
		for dir in 4:
			if (openings[cell] & (1 << dir)) != 0:
				continue
			var nb_c: int = _genus2_neighbor(cell, dir, n, walkable)
			if nb_c < 0:
				continue
			closed_neighbors.append([dir, nb_c])
		if closed_neighbors.is_empty():
			continue
		rng_state = _lcg_next(rng_state)
		var pick: Array = closed_neighbors[rng_state % closed_neighbors.size()]
		var pick_dir2: int = pick[0]
		var pick_cell: int = pick[1]
		openings[cell] = openings[cell] | (1 << pick_dir2)
		openings[pick_cell] = openings[pick_cell] | (1 << _opposite(pick_dir2))

	# Emit walls.
	var out: Array = []
	for r in range(n):
		for c in range(n):
			var id: int = c + r * n
			if walkable[id] == 0:
				continue
			var east_closed: bool = (openings[id] & (1 << DIR_EAST)) == 0
			var north_closed: bool = (openings[id] & (1 << DIR_NORTH)) == 0
			var east_nbr: int = _genus2_neighbor(id, DIR_EAST, n, walkable)
			var north_nbr: int = _genus2_neighbor(id, DIR_NORTH, n, walkable)
			if east_closed and east_nbr >= 0:
				var x: float = float(c + 1) * cell_size - half_ext
				var z0: float = float(r) * cell_size - half_ext
				var z1: float = float(r + 1) * cell_size - half_ext
				out.append({"ax": x, "az": z0, "bx": x, "bz": z1})
			if north_closed and north_nbr >= 0:
				var z: float = float(r + 1) * cell_size - half_ext
				var x0: float = float(c) * cell_size - half_ext
				var x1: float = float(c + 1) * cell_size - half_ext
				out.append({"ax": x0, "az": z, "bx": x1, "bz": z})
	return out

static func _genus2_neighbor(cell: int, dir: int, n: int, walkable: PackedByteArray) -> int:
	var cc: int = cell % n
	var cr: int = cell / n
	var nc: int = cc
	var nr: int = cr
	if dir == DIR_EAST:
		nc = cc + 1
	elif dir == DIR_WEST:
		nc = cc - 1
	elif dir == DIR_NORTH:
		nr = cr + 1
	elif dir == DIR_SOUTH:
		nr = cr - 1
	if nc < 0 or nc >= n or nr < 0 or nr >= n:
		return -1
	var idx: int = nc + nr * n
	if walkable[idx] == 0:
		return -1
	return idx

# Möbius strip maze. 2N x N rectangular grid (default 20 x 10) covering the
# strip's [-Lx, Lx] x [-Lz, Lz] domain. x wraps with a row flip (the same
# identification the topology adapter uses); z is hard-bounded. Mirrors
# backend/shared/src/gridMaze.ts::generateMobiusGridWalls.
const MOBIUS_GRID_X := 2 * GRID_MAZE_N
const MOBIUS_GRID_Z := GRID_MAZE_N
const MOBIUS_HALF_X := 40.0
const MOBIUS_HALF_Z := 20.0

static func _mobius_neighbor(cell: int, dir: int, cols: int, rows: int) -> int:
	var cc: int = cell % cols
	var cr: int = cell / cols
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
	if nc < 0 or nc >= cols:
		nc = posmod(nc, cols)
		flip_row = true
	if nr < 0 or nr >= rows:
		return -1
	if flip_row:
		nr = rows - 1 - nr
	return nc + nr * cols

static func _generate_mobius(seed_value: int) -> Array:
	var cols: int = MOBIUS_GRID_X
	var rows: int = MOBIUS_GRID_Z
	var total: int = cols * rows
	var cell_size: float = (2.0 * MOBIUS_HALF_X) / float(cols)
	var half_x: float = MOBIUS_HALF_X
	var half_z: float = MOBIUS_HALF_Z

	var rng_state: int = seed_value & 0xFFFFFFFF
	var visited := PackedByteArray()
	visited.resize(total)
	var openings := PackedByteArray()
	openings.resize(total)

	rng_state = _lcg_next(rng_state)
	var start: int = rng_state % total
	visited[start] = 1
	var stack: Array[int] = [start]
	while not stack.is_empty():
		var cur: int = stack[stack.size() - 1]
		var candidates: Array = []
		for dir in 4:
			var nb: int = _mobius_neighbor(cur, dir, cols, rows)
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

	# Braid dead ends.
	for cell in range(total):
		if _popcount_nibble(openings[cell]) >= 2:
			continue
		var closed_neighbors: Array = []
		for dir in 4:
			if (openings[cell] & (1 << dir)) != 0:
				continue
			var nb: int = _mobius_neighbor(cell, dir, cols, rows)
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

	# Emit walls. East seam (last col) skipped because it identifies via the
	# wrap. North/south interior walls between cells. Hard top/bottom walls
	# emitted at the end.
	var out: Array = []
	for r in range(rows):
		for c in range(cols):
			var id: int = c + r * cols
			var east_closed: bool = (openings[id] & (1 << DIR_EAST)) == 0
			var north_closed: bool = (openings[id] & (1 << DIR_NORTH)) == 0
			var is_last_col: bool = c == cols - 1
			var is_last_row: bool = r == rows - 1
			if east_closed and not is_last_col:
				var x: float = float(c + 1) * cell_size - half_x
				var z0: float = float(r) * cell_size - half_z
				var z1: float = float(r + 1) * cell_size - half_z
				out.append({"ax": x, "az": z0, "bx": x, "bz": z1})
			if north_closed and not is_last_row:
				var z: float = float(r + 1) * cell_size - half_z
				var x0: float = float(c) * cell_size - half_x
				var x1: float = float(c + 1) * cell_size - half_x
				out.append({"ax": x0, "az": z, "bx": x1, "bz": z})
	# Hard top and bottom boundary walls.
	for c in range(cols):
		var x0: float = float(c) * cell_size - half_x
		var x1: float = float(c + 1) * cell_size - half_x
		out.append({"ax": x0, "az": half_z, "bx": x1, "bz": half_z})
		out.append({"ax": x0, "az": -half_z, "bx": x1, "bz": -half_z})
	return out
