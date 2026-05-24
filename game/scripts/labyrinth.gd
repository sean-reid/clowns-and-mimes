extends Node3D

## Labyrinth. The visual layout depends on topology:
##   * Plane, torus, Klein: grid maze (mirrors backend/shared/src/gridMaze.ts).
##     Plane gets closed boundary walls; torus and Klein skip them since the
##     wrap folds both edges to the same line.
##   * Sphere: concentric rings pending cube-mapped topology rework.
##
## Walls are deterministic given a seed and feed a topology-aware AStar2D graph
## for bot pathfinding.

const TopologyScript := preload("res://scripts/topology/topology.gd")
const GridMaze := preload("res://scripts/grid_maze.gd")

const WALL_HEIGHT := 6.0
const WALL_THICKNESS := 0.4
const SYMMETRY_ORDER := 12
const RING_RADII: Array[float] = [6.0, 12.0, 18.0, 24.0, 30.0, 36.0]
const CENTER_SQUARE_SIZE := 4.0

const GRID_RES := 80
const CELL_SIZE := TopologyScript.WIDTH / float(GRID_RES)
const PLAYER_CLEARANCE := 0.55

var seed_value: int = 0
var topology: TopologyScript
var pathfinder: AStar2D
var solid_cells: Dictionary = {}

var walls_root: Node3D
var floor_node: MeshInstance3D
var _wall_segments: Array = []  # [{transform, length}, ...]

func build(rng_seed: int, top: TopologyScript) -> void:
	seed_value = rng_seed
	topology = top
	_resolve_children()
	_ensure_floor()
	_clear_walls()
	_wall_segments.clear()
	var topo_name: String = topology.name()
	if topo_name != "sphere":
		_build_grid_maze(rng_seed, topo_name)
	else:
		var rng := RandomNumberGenerator.new()
		rng.seed = rng_seed
		for ring_index in RING_RADII.size():
			_build_ring(ring_index, rng)
	_build_pathfinder()

func _build_grid_maze(rng_seed: int, topo_name: String) -> void:
	# Each maze segment is a thin straight wall between two grid cells. The
	# rest of the labyrinth code already treats walls as oriented boxes, so we
	# translate each {ax,az,bx,bz} into the same transform shape _add_arc_wall
	# would produce.
	for seg in GridMaze.generate(rng_seed, topo_name):
		var ax: float = float(seg["ax"])
		var az: float = float(seg["az"])
		var bx: float = float(seg["bx"])
		var bz: float = float(seg["bz"])
		var mid := Vector3((ax + bx) * 0.5, WALL_HEIGHT / 2.0, (az + bz) * 0.5)
		var dx: float = bx - ax
		var dz: float = bz - az
		var seg_length: float = sqrt(dx * dx + dz * dz)
		var yaw: float = atan2(dz, dx)
		var wall: StaticBody3D = _make_wall(seg_length)
		wall.position = mid
		wall.rotation = Vector3(0.0, -yaw, 0.0)
		walls_root.add_child(wall)
		_wall_segments.append({"transform": wall.transform, "length": seg_length})

func find_path(from: Vector3, to: Vector3) -> Array[Vector3]:
	if pathfinder == null:
		return []
	var from_cell: Vector2i = _world_to_cell(from)
	var to_cell: Vector2i = _world_to_cell(to)
	if _is_solid(to_cell):
		to_cell = _nearest_open_cell(to_cell)
	if _is_solid(from_cell):
		from_cell = _nearest_open_cell(from_cell)
	var raw: PackedVector2Array = pathfinder.get_point_path(_cell_id(from_cell), _cell_id(to_cell))
	var out: Array[Vector3] = []
	for point in raw:
		out.append(_cell_to_world(Vector2i(int(point.x), int(point.y))))
	return out

# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

func _resolve_children() -> void:
	walls_root = get_node_or_null("Walls") as Node3D
	if walls_root == null:
		walls_root = Node3D.new()
		walls_root.name = "Walls"
		add_child(walls_root)
	floor_node = get_node_or_null("Floor") as MeshInstance3D
	if floor_node == null:
		floor_node = MeshInstance3D.new()
		floor_node.name = "Floor"
		add_child(floor_node)

func _ensure_floor() -> void:
	var plane := PlaneMesh.new()
	plane.size = Vector2(TopologyScript.WIDTH, TopologyScript.WIDTH)
	floor_node.mesh = plane
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.09, 0.09, 0.11)
	mat.roughness = 0.95
	floor_node.material_override = mat

func _clear_walls() -> void:
	for child in walls_root.get_children():
		child.queue_free()

func _build_ring(ring_index: int, rng: RandomNumberGenerator) -> void:
	var radius: float = RING_RADII[ring_index]
	var segments: int = SYMMETRY_ORDER
	var gap_count: int = _gaps_for_ring(ring_index)
	var gap_indices: Array[int] = _choose_gap_indices(segments, gap_count, ring_index, rng)
	for s in segments:
		if gap_indices.has(s):
			continue
		var start_angle: float = TAU * (float(s) / float(segments))
		var end_angle: float = TAU * (float(s + 1) / float(segments))
		_add_arc_wall(radius, start_angle, end_angle)

func _gaps_for_ring(ring_index: int) -> int:
	return max(1, SYMMETRY_ORDER / (2 + ring_index))

func _choose_gap_indices(
	segments: int, gap_count: int, ring_index: int, _rng: RandomNumberGenerator
) -> Array[int]:
	# Deterministic jitter derived from (seed, ring, k) instead of an RNG so
	# the TypeScript server can compute identical walls without sharing a
	# random stream. Matches backend/shared/src/labyrinth.ts::gapJitter.
	var stagger: int = 1 if ring_index % 2 == 1 else 0
	var step: int = max(1, segments / gap_count)
	var indices: Array[int] = []
	for k in gap_count:
		indices.append((k * step + stagger + _gap_jitter(seed_value, ring_index, k)) % segments)
	return indices

static func _gap_jitter(seed_value_arg: int, ring: int, k: int) -> int:
	var mask: int = 0xFFFFFFFF
	var h: int = (seed_value_arg ^ 0x9e3779b9) & mask
	h = ((h ^ (ring + 0x85ebca6b)) * 0xc2b2ae35) & mask
	h = h ^ ((h >> 16) & mask)
	h = ((h ^ (k + 0x27d4eb2f)) * 0x165667b1) & mask
	h = h ^ ((h >> 13) & mask)
	return h % 2

func _add_arc_wall(radius: float, start_angle: float, end_angle: float) -> void:
	var subdivisions: int = 4
	for i in subdivisions:
		var t0: float = float(i) / float(subdivisions)
		var t1: float = float(i + 1) / float(subdivisions)
		var a0: float = lerpf(start_angle, end_angle, t0)
		var a1: float = lerpf(start_angle, end_angle, t1)
		var mid: float = (a0 + a1) * 0.5
		var p := Vector3(cos(mid) * radius, WALL_HEIGHT / 2.0, sin(mid) * radius)
		var seg_length: float = 2.0 * radius * sin((a1 - a0) / 2.0)
		var wall: StaticBody3D = _make_wall(seg_length)
		wall.position = p
		wall.rotation = Vector3(0.0, -mid - PI / 2.0, 0.0)
		walls_root.add_child(wall)
		_wall_segments.append({"transform": wall.transform, "length": seg_length})

func _make_wall(seg_length: float) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.collision_layer = 1
	body.collision_mask = 0
	var mesh_node := MeshInstance3D.new()
	mesh_node.name = "Mesh"
	var mesh := BoxMesh.new()
	mesh.size = Vector3(seg_length, WALL_HEIGHT, WALL_THICKNESS)
	mesh_node.mesh = mesh
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.18, 0.18, 0.22)
	mat.roughness = 0.85
	mesh_node.material_override = mat
	body.add_child(mesh_node)
	var collider := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = Vector3(seg_length, WALL_HEIGHT, WALL_THICKNESS)
	collider.shape = shape
	body.add_child(collider)
	return body

# ---------------------------------------------------------------------------
# Pathfinding graph
# ---------------------------------------------------------------------------

func _build_pathfinder() -> void:
	pathfinder = AStar2D.new()
	solid_cells.clear()
	for cy in range(GRID_RES):
		for cx in range(GRID_RES):
			pathfinder.add_point(_cell_id(Vector2i(cx, cy)), Vector2(cx, cy))
	for segment in _wall_segments:
		_mark_wall_solid(segment["transform"], segment["length"])
	_connect_neighbors()

func _connect_neighbors() -> void:
	var wrap_x: bool = topology != null and topology.wraps_x()
	var wrap_z: bool = topology != null and topology.wraps_z()
	var flip_z: bool = topology != null and topology.flips_z_on_x_wrap()
	for cy in range(GRID_RES):
		for cx in range(GRID_RES):
			var from_cell := Vector2i(cx, cy)
			if _is_solid(from_cell):
				continue
			for dx in [-1, 0, 1]:
				for dy in [-1, 0, 1]:
					if dx == 0 and dy == 0:
						continue
					var nb: Vector2i = _wrap_cell(Vector2i(cx + dx, cy + dy), wrap_x, wrap_z, flip_z)
					if nb.x < 0:
						continue
					if _is_solid(nb):
						continue
					var from_id: int = _cell_id(from_cell)
					var to_id: int = _cell_id(nb)
					if not pathfinder.are_points_connected(from_id, to_id):
						pathfinder.connect_points(from_id, to_id, true)

func _wrap_cell(cell: Vector2i, wrap_x: bool, wrap_z: bool, flip_z: bool) -> Vector2i:
	var cx: int = cell.x
	var cy: int = cell.y
	var x_crossed := false
	if cx < 0:
		if not wrap_x:
			return Vector2i(-1, -1)
		cx += GRID_RES
		x_crossed = true
	elif cx >= GRID_RES:
		if not wrap_x:
			return Vector2i(-1, -1)
		cx -= GRID_RES
		x_crossed = true
	if cy < 0:
		if not wrap_z:
			return Vector2i(-1, -1)
		cy += GRID_RES
	elif cy >= GRID_RES:
		if not wrap_z:
			return Vector2i(-1, -1)
		cy -= GRID_RES
	if x_crossed and flip_z:
		cy = GRID_RES - 1 - cy
	return Vector2i(cx, cy)

func _mark_wall_solid(wall_xform: Transform3D, seg_length: float) -> void:
	var half_len: float = seg_length * 0.5 + PLAYER_CLEARANCE
	var half_thick: float = WALL_THICKNESS * 0.5 + PLAYER_CLEARANCE
	var inverse: Transform3D = wall_xform.affine_inverse()
	var min_pos := Vector3(INF, 0.0, INF)
	var max_pos := Vector3(-INF, 0.0, -INF)
	for dx in [-half_len, half_len]:
		for dz in [-half_thick, half_thick]:
			var w: Vector3 = wall_xform * Vector3(dx, 0.0, dz)
			min_pos.x = min(min_pos.x, w.x)
			min_pos.z = min(min_pos.z, w.z)
			max_pos.x = max(max_pos.x, w.x)
			max_pos.z = max(max_pos.z, w.z)
	var min_cell: Vector2i = _world_to_cell(min_pos)
	var max_cell: Vector2i = _world_to_cell(max_pos)
	for cx in range(min_cell.x, max_cell.x + 1):
		for cy in range(min_cell.y, max_cell.y + 1):
			var cell := Vector2i(cx, cy)
			var world_point: Vector3 = _cell_to_world(cell)
			var local: Vector3 = inverse * world_point
			if absf(local.x) <= half_len and absf(local.z) <= half_thick:
				solid_cells[_cell_id(cell)] = true

func _is_solid(cell: Vector2i) -> bool:
	if cell.x < 0 or cell.x >= GRID_RES or cell.y < 0 or cell.y >= GRID_RES:
		return true
	return solid_cells.has(_cell_id(cell))

func _cell_id(cell: Vector2i) -> int:
	return cell.y * GRID_RES + cell.x

func _world_to_cell(p: Vector3) -> Vector2i:
	var half: float = TopologyScript.WIDTH * 0.5
	var x: int = int(round((p.x + half) / CELL_SIZE))
	var y: int = int(round((p.z + half) / CELL_SIZE))
	return Vector2i(clamp(x, 0, GRID_RES - 1), clamp(y, 0, GRID_RES - 1))

func _cell_to_world(cell: Vector2i) -> Vector3:
	var half: float = TopologyScript.WIDTH * 0.5
	var x: float = float(cell.x) * CELL_SIZE - half + CELL_SIZE * 0.5
	var z: float = float(cell.y) * CELL_SIZE - half + CELL_SIZE * 0.5
	return Vector3(x, 0.0, z)

func _nearest_open_cell(cell: Vector2i) -> Vector2i:
	for radius in range(1, 6):
		for dx in range(-radius, radius + 1):
			for dy in range(-radius, radius + 1):
				var c := Vector2i(cell.x + dx, cell.y + dy)
				if c.x < 0 or c.x >= GRID_RES or c.y < 0 or c.y >= GRID_RES:
					continue
				if not _is_solid(c):
					return c
	return cell
