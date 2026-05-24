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

# Sphere T-net cube layout. Six square faces in a 4 x 3 grid. Each face is
# a SPHERE_FACE_CELLS x SPHERE_FACE_CELLS maze. Mirrors
# backend/shared/src/gridMaze.ts so the TS server and the GDScript client
# agree on every wall.
const SPHERE_FACE_CELLS := 5
const FACE_GRID_COLS := 4
const FACE_GRID_ROWS := 3
const SPHERE_GRID_X := FACE_GRID_COLS * SPHERE_FACE_CELLS  # 20
const SPHERE_GRID_Z := FACE_GRID_ROWS * SPHERE_FACE_CELLS  # 15

# CUBE_FACES order mirrors backend/shared/src/sphereCubeMap.ts. The maze
# generator iterates this list and consumes LCG draws in this order; any
# divergence with the TS side would produce mismatched walls.
const CUBE_FACES: Array[String] = ['+Y', '-X', '+Z', '+X', '-Z', '-Y']
const FACE_SLOTS := {
	'+Y': Vector2i(1, 0),
	'-X': Vector2i(0, 1),
	'+Z': Vector2i(1, 1),
	'+X': Vector2i(2, 1),
	'-Z': Vector2i(3, 1),
	'-Y': Vector2i(1, 2),
}

const TopologyScript := preload("res://scripts/topology/topology.gd")

static func generate(seed_value: int, topology_name: String, grid_n: int = GRID_MAZE_N) -> Array:
	if topology_name == "sphere":
		return _generate_sphere(seed_value)
	if topology_name == "klein":
		return _generate_klein(seed_value, grid_n)
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

# Sphere wall list: six independent grid mazes laid out 3x2 in the playfield.
# Each face is a 4x6 cell grid. Face boundaries carry no walls so a player
# crossing a face edge wraps onto the adjacent face via the topology adapter.
#
# Faces are visited in a fixed order (row 0 col 0, row 0 col 1, row 0 col 2,
# row 1 col 0, row 1 col 1, row 1 col 2) and share one LCG state, mirroring
# backend/shared/src/gridMaze.ts::generateSphereGridWalls.
#
# Sphere T-net cube map. Six independent N x N face mazes placed in the
# T-net slots:
#
#                col=0  col=1  col=2  col=3
#        row=0          +Y
#        row=1   -X     +Z     +X     -Z
#        row=2          -Y
#
# Walls are interior to each face. Outer face edges stay open so
# grid-adjacent face seams (like +Z east -> +X west) flow naturally and
# void-adjacent edges (like +X north into the (2, 0) void) trigger the cube
# identification in sphere_topology.gd::wrap_step.
static func _generate_sphere(seed_value: int) -> Array:
	var n: int = SPHERE_FACE_CELLS
	var face_total: int = n * n
	var face_side: float = TopologyScript.WIDTH / float(FACE_GRID_COLS)
	var cell_size: float = face_side / float(n)
	var ext_x: float = float(FACE_GRID_COLS) * face_side
	var ext_z: float = float(FACE_GRID_ROWS) * face_side
	var out: Array = []
	var rng_state: int = seed_value & 0xFFFFFFFF
	for face in CUBE_FACES:
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
				var nb: int = _sphere_local_neighbor(cur, dir, n)
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
		for cell in face_total:
			if _popcount_nibble(local_openings[cell]) >= 2:
				continue
			var closed_neighbors: Array = []
			for dir in 4:
				if (local_openings[cell] & (1 << dir)) != 0:
					continue
				var nb: int = _sphere_local_neighbor(cell, dir, n)
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
		# Emit walls in world coords. Drop walls on the face's outer edges
		# so every face boundary remains open.
		var slot: Vector2i = FACE_SLOTS[face]
		var x_min: float = slot.x * face_side - ext_x * 0.5
		var z_max: float = ext_z * 0.5 - slot.y * face_side
		var z_min: float = z_max - face_side
		for r in n:
			for c in n:
				var id: int = c + r * n
				var east_closed: bool = (local_openings[id] & (1 << DIR_EAST)) == 0
				var north_closed: bool = (local_openings[id] & (1 << DIR_NORTH)) == 0
				if east_closed and c < n - 1:
					var x: float = x_min + float(c + 1) * cell_size
					var z0: float = z_min + float(r) * cell_size
					var z1: float = z_min + float(r + 1) * cell_size
					out.append({"ax": x, "az": z0, "bx": x, "bz": z1})
				if north_closed and r < n - 1:
					var z: float = z_min + float(r + 1) * cell_size
					var x0: float = x_min + float(c) * cell_size
					var x1: float = x_min + float(c + 1) * cell_size
					out.append({"ax": x0, "az": z, "bx": x1, "bz": z})
	return out

static func _sphere_local_neighbor(local_cell: int, dir: int, n: int) -> int:
	var lc: int = local_cell % n
	var lr: int = local_cell / n
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
	if nc < 0 or nc >= n:
		return -1
	if nr < 0 or nr >= n:
		return -1
	return nc + nr * n

# _emit_sphere_walls from the old 3 x 2 packing was inlined into
# _generate_sphere. Keeping the function removed avoids dead-code drift.
