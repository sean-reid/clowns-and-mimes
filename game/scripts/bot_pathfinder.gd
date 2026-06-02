extends RefCounted

## Weighted-A* grid pathfinder for offline bots. Ports
## backend/room/src/botPathfinder.ts: A* over the maze cell grid with a cost
## field (wall-proximity + occupancy), then a clearance-aware string-pull funnel
## so the bot aims at the farthest waypoint its body can reach in a straight
## line. Same algorithm and weights as the server, so offline navigation
## matches online (including the corner-clearance behavior).
##
## Positions are Vector3 (XZ ground); the search works in cell indices.

const SharedConstants := preload("res://scripts/shared_constants.gd")
const GridMaze := preload("res://scripts/grid_maze.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")

const WORLD_WIDTH := 80.0
const WALL_AVOID_WEIGHT := SharedConstants.WALL_AVOID_WEIGHT
const OCCUPANCY_WEIGHT := SharedConstants.OCCUPANCY_WEIGHT

var _walls: Array = []
var _cols: int = 0
var _rows: int = 0
var _cell_x: float = 0.0
var _cell_z: float = 0.0
var _wrap_x: bool = false
var _wrap_z: bool = false
var _flip_row_on_x_wrap: bool = false
var _seam_threshold: float = 0.0
var _adjacency: PackedByteArray = PackedByteArray()
var _wall_cost: PackedFloat32Array = PackedFloat32Array()
var _chain_cache: Dictionary = {}

func _init(walls: Array, topology_name: String) -> void:
	_walls = walls
	_apply_shape(topology_name)
	var total := _cols * _rows
	_adjacency.resize(total)
	_wall_cost.resize(total)
	_seam_threshold = 2.0 * maxf(_cell_x, _cell_z)
	_build_adjacency()
	_compute_wall_cost()

func next_waypoint(from: Vector3, to: Vector3) -> Vector3:
	var from_cell := _world_to_cell(from.x, from.z)
	var to_cell := _world_to_cell(to.x, to.z)
	if from_cell == to_cell:
		return to
	if _directly_reachable(from_cell, to_cell):
		return to
	return _funnel(from, _cached_chain(from_cell, to_cell), to)

func next_waypoint_avoiding(from: Vector3, to: Vector3, occupied: Dictionary) -> Vector3:
	if occupied.is_empty():
		return next_waypoint(from, to)
	var from_cell := _world_to_cell(from.x, from.z)
	var to_cell := _world_to_cell(to.x, to.z)
	if from_cell == to_cell:
		return to
	return _funnel(from, _astar_chain(from_cell, to_cell, occupied), to)

func cell_at(pos: Vector3) -> int:
	return _world_to_cell(pos.x, pos.z)

func cell_center_of(pos: Vector3) -> Vector3:
	var c := _cell_center(_world_to_cell(pos.x, pos.z))
	return Vector3(c.x, pos.y, c.y)

func _cached_chain(from_cell: int, to_cell: int) -> Array:
	var key := from_cell * (_cols * _rows) + to_cell
	if _chain_cache.has(key):
		return _chain_cache[key]
	var chain := _astar_chain(from_cell, to_cell, {})
	_chain_cache[key] = chain
	return chain

# Weighted A*. Step cost into a cell is 1 + its static wall cost, plus
# OCCUPANCY_WEIGHT when occupied (never the destination). Heuristic is the
# wrap-aware cell Manhattan distance, admissible since min step cost is 1.
# Returns the cells after from_cell through to_cell, or [] if unreachable.
func _astar_chain(from_cell: int, to_cell: int, occupied: Dictionary) -> Array:
	var total := _cols * _rows
	var g := PackedFloat32Array()
	g.resize(total)
	g.fill(INF)
	var f := PackedFloat32Array()
	f.resize(total)
	f.fill(INF)
	var came := PackedInt32Array()
	came.resize(total)
	came.fill(-1)
	var closed := PackedByteArray()
	closed.resize(total)
	g[from_cell] = 0.0
	f[from_cell] = _cell_heuristic(from_cell, to_cell)
	var open: Array[int] = [from_cell]
	while not open.is_empty():
		var bi := 0
		for i in range(1, open.size()):
			if f[open[i]] < f[open[bi]]:
				bi = i
		var cur: int = open[bi]
		open.remove_at(bi)
		if cur == to_cell:
			break
		if closed[cur] == 1:
			continue
		closed[cur] = 1
		var cc := cur % _cols
		@warning_ignore("integer_division")
		var cr := cur / _cols
		var mask := _adjacency[cur]
		for dir in 4:
			if (mask & (1 << dir)) == 0:
				continue
			var nb := _neighbor_cell(cc, cr, dir)
			if nb < 0 or closed[nb] == 1:
				continue
			var step := 1.0 + _wall_cost[nb]
			if nb != to_cell and occupied.has(nb):
				step += OCCUPANCY_WEIGHT
			var tentative: float = g[cur] + step
			if tentative < g[nb]:
				g[nb] = tentative
				came[nb] = cur
				f[nb] = tentative + _cell_heuristic(nb, to_cell)
				open.append(nb)
	if is_inf(g[to_cell]):
		return []
	var rev: Array[int] = []
	var cur := to_cell
	while cur != from_cell:
		rev.append(cur)
		cur = came[cur]
	rev.reverse()
	return rev

# String-pull the cell chain against clearance-aware line of sight: advance to
# the farthest cell center the body can reach in a straight, wall-free line.
func _funnel(from: Vector3, chain: Array, to: Vector3) -> Vector3:
	if chain.is_empty():
		return to
	var pts: Array[Vector2] = []
	for c in chain:
		pts.append(_cell_center(c))
	pts[pts.size() - 1] = Vector2(to.x, to.z)
	var best := pts[0]
	var prev := Vector2(from.x, from.z)
	for c in pts:
		if absf(c.x - prev.x) > _seam_threshold or absf(c.y - prev.y) > _seam_threshold:
			break
		if not _walls.is_empty() and not WallGeometry.path_clears_walls(_walls, from.x, from.z, c.x, c.y):
			break
		best = c
		prev = c
	return Vector3(best.x, from.y, best.y)

func _cell_heuristic(a: int, b: int) -> float:
	var ac := a % _cols
	@warning_ignore("integer_division")
	var ar := a / _cols
	var bc := b % _cols
	@warning_ignore("integer_division")
	var br := b / _cols
	var dc := absi(ac - bc)
	if _wrap_x:
		dc = mini(dc, _cols - dc)
	var dr := absi(ar - br)
	if _wrap_z:
		dr = mini(dr, _rows - dr)
	return float(dc + dr)

func _compute_wall_cost() -> void:
	var total := _cols * _rows
	for cell in total:
		var open_sides := 0
		var mask := _adjacency[cell]
		for dir in 4:
			if mask & (1 << dir):
				open_sides += 1
		_wall_cost[cell] = float(4 - open_sides) * WALL_AVOID_WEIGHT

func _build_adjacency() -> void:
	var seam := 2.0 * maxf(_cell_x, _cell_z)
	for r in _rows:
		for c in _cols:
			var cell := c + r * _cols
			var mask := 0
			for dir in 4:
				var nb := _neighbor_cell(c, r, dir)
				if nb < 0:
					continue
				var a := _cell_center(cell)
				var b := _cell_center(nb)
				if absf(b.x - a.x) > seam or absf(b.y - a.y) > seam:
					mask |= 1 << dir
					continue
				if not WallGeometry.path_crosses_wall(_walls, a.x, a.y, b.x, b.y):
					mask |= 1 << dir
			_adjacency[cell] = mask

func _directly_reachable(from_cell: int, to_cell: int) -> bool:
	var cc := from_cell % _cols
	@warning_ignore("integer_division")
	var cr := from_cell / _cols
	for dir in 4:
		if (_adjacency[from_cell] & (1 << dir)) == 0:
			continue
		if _neighbor_cell(cc, cr, dir) == to_cell:
			return true
	return false

# dir: 0 east (+x), 1 north (+z), 2 west (-x), 3 south (-z). Mirrors
# botPathfinder.neighborCell.
func _neighbor_cell(col: int, row: int, dir: int) -> int:
	var nc := col
	var nr := row
	var flip_row := false
	if dir == 0:
		nc = col + 1
	elif dir == 2:
		nc = col - 1
	elif dir == 1:
		nr = row + 1
	elif dir == 3:
		nr = row - 1
	if nc < 0 or nc >= _cols:
		if not _wrap_x:
			return -1
		nc = ((nc % _cols) + _cols) % _cols
		if _flip_row_on_x_wrap:
			flip_row = true
	if nr < 0 or nr >= _rows:
		if not _wrap_z:
			return -1
		nr = ((nr % _rows) + _rows) % _rows
	if flip_row:
		nr = _rows - 1 - nr
	return nc + nr * _cols

func _world_to_cell(x: float, z: float) -> int:
	var half_x := (_cols * _cell_x) / 2.0
	var half_z := (_rows * _cell_z) / 2.0
	var c := floori((x + half_x) / _cell_x)
	var r := floori((z + half_z) / _cell_z)
	if _wrap_x:
		c = ((c % _cols) + _cols) % _cols
	else:
		c = clampi(c, 0, _cols - 1)
	if _wrap_z:
		r = ((r % _rows) + _rows) % _rows
	else:
		r = clampi(r, 0, _rows - 1)
	return c + r * _cols

# Returns the cell center as Vector2(world_x, world_z).
func _cell_center(cell: int) -> Vector2:
	var c := cell % _cols
	@warning_ignore("integer_division")
	var r := cell / _cols
	var half_x := (_cols * _cell_x) / 2.0
	var half_z := (_rows * _cell_z) / 2.0
	return Vector2((c + 0.5) * _cell_x - half_x, (r + 0.5) * _cell_z - half_z)

func _apply_shape(topology_name: String) -> void:
	if topology_name == "klein":
		_cols = 2 * GridMaze.GRID_MAZE_N
		_rows = GridMaze.GRID_MAZE_N
		_cell_x = WORLD_WIDTH / GridMaze.GRID_MAZE_N
		_cell_z = WORLD_WIDTH / GridMaze.GRID_MAZE_N
		_wrap_x = true
		_wrap_z = true
		_flip_row_on_x_wrap = false
		return
	if topology_name == "mobius":
		_cols = GridMaze.MOBIUS_GRID_X
		_rows = GridMaze.MOBIUS_GRID_Z
		_cell_x = (2.0 * GridMaze.MOBIUS_HALF_X) / GridMaze.MOBIUS_GRID_X
		_cell_z = (2.0 * GridMaze.MOBIUS_HALF_Z) / GridMaze.MOBIUS_GRID_Z
		_wrap_x = true
		_wrap_z = false
		_flip_row_on_x_wrap = false
		return
	_cols = GridMaze.GRID_MAZE_N
	_rows = GridMaze.GRID_MAZE_N
	_cell_x = WORLD_WIDTH / GridMaze.GRID_MAZE_N
	_cell_z = WORLD_WIDTH / GridMaze.GRID_MAZE_N
	_wrap_x = topology_name != "plane"
	_wrap_z = topology_name != "plane"
	_flip_row_on_x_wrap = false
