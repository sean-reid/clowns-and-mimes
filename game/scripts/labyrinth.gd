extends Node3D

## Labyrinth. Every topology now drives the grid maze (mirrors
## backend/shared/src/gridMaze.ts):
##   * Plane: closed rectangle with boundary walls.
##   * Torus and Klein: wrap seams have no walls so the topology folds both
##     edges to the same line.
##   * Möbius: cylindrical double cover with hard top/bottom walls.
##
## The ring layout (_build_ring, _add_arc_wall) is no longer dispatched but is
## kept for an experimental lobby mode that may opt back in.
##
## Walls are deterministic given a seed. Bots pathfind off the wall_endpoints
## list via bot_pathfinder.gd (the shared weighted-A* port); this node only owns
## the geometry + its rendering.

const TopologyScript := preload("res://scripts/topology/topology.gd")
const GridMaze := preload("res://scripts/grid_maze.gd")
const WALL_SHADER := preload("res://shaders/wall_uplight.gdshader")

const WALL_HEIGHT := 6.0
const WALL_THICKNESS := 0.4

# Phase-tint crossfade duration. Soft enough that a turn flip washes the wall
# glow over rather than popping.
const TINT_FADE_S := 0.5
const TINT_NEUTRAL := Color(1.0, 1.0, 1.0)
const TINT_CLOWN := Color(1.0, 0.55, 0.35)  # warm reddish-orange
const TINT_MIME := Color(0.78, 0.88, 1.0)  # cool pale-blue
const SYMMETRY_ORDER := 12
const RING_RADII: Array[float] = [6.0, 12.0, 18.0, 24.0, 30.0, 36.0]
const CENTER_SQUARE_SIZE := 4.0

var seed_value: int = 0
var topology: TopologyScript

var walls_root: Node3D
var floor_node: MeshInstance3D
# One ShaderMaterial shared across every wall mesh (primary + wrap tiles). The
# uplight band is a fraction of WALL_HEIGHT in object space, identical on every
# wall regardless of length, so a single material with one tint uniform lets a
# phase change tint the whole maze with one write. Built lazily in build().
var _wall_material: ShaderMaterial
var _tint_tween: Tween
var _wall_segments: Array = []  # [{transform, length}, ...]
# Raw wall endpoint pairs in world XZ coords, parallel to _wall_segments.
# The local-player predictor reads this to mirror the server's pathCrossesWall
# check; the server uses the same {ax,az,bx,bz} representation, so wall
# collision matches on both sides during reconciliation replay.
var _wall_endpoints: Array = []  # [{ax, az, bx, bz}, ...]

func build(rng_seed: int, top: TopologyScript) -> void:
	seed_value = rng_seed
	topology = top
	_resolve_children()
	_ensure_wall_material()
	_ensure_floor()
	_clear_walls()
	_wall_segments.clear()
	_wall_endpoints.clear()
	var topo_name: String = topology.name()
	_build_grid_maze(rng_seed, topo_name)
	_build_wrap_tiles()

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
		_wall_endpoints.append({"ax": ax, "az": az, "bx": bx, "bz": bz})

func wall_endpoints() -> Array:
	return _wall_endpoints

# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

## Clones the floor and walls into the 8 neighbouring tiles offset by the
## topology's playfield extents so a player at the seam looks across and sees
## the wrapped portion of the map instead of an opaque edge. The clones are
## visual only - no collision - because the topology.wrap teleport in
## arena.gd keeps the body inside the canonical domain.
##
## Klein is now a true double cover (the right half of the maze is the
## z-mirror of the left), so wrap tiles for Klein just translate by the
## playfield extents and never apply an extra z-flip - the flip is baked
## into the maze geometry itself.
func _build_wrap_tiles() -> void:
	var prior_tiles: Node = get_node_or_null("WrapTiles")
	if prior_tiles != null:
		prior_tiles.queue_free()
	if topology == null:
		return
	var topo_name: String = topology.name()
	if topo_name == "plane":
		return
	var tiles_root := Node3D.new()
	tiles_root.name = "WrapTiles"
	add_child(tiles_root)
	# Torus / Klein / Möbius: 3x3 flat-translated wrap-tile lattice. Klein
	# and Möbius bake their orientation flip into the maze geometry (right
	# half is the z-mirror of the left), so a pure translation works for
	# the visual seam in both cases. The Möbius z-edges are hard walls;
	# we still render the vertical neighbours so the player sees the
	# maze continuing past the x-seam, but the top/bottom tiles will be
	# clipped naturally by the hard-wall collision.
	var ext_x: float = topology.extent_x()
	var ext_z: float = topology.extent_z()
	for dx in [-1, 0, 1]:
		for dz in [-1, 0, 1]:
			if dx == 0 and dz == 0:
				continue
			var tile := Node3D.new()
			tile.position = Vector3(float(dx) * ext_x, 0.0, float(dz) * ext_z)
			tiles_root.add_child(tile)
			_populate_wrap_tile(tile)

func _populate_wrap_tile(tile: Node3D) -> void:
	var floor_clone := MeshInstance3D.new()
	floor_clone.mesh = floor_node.mesh
	floor_clone.material_override = floor_node.material_override
	tile.add_child(floor_clone)
	for seg in _wall_segments:
		var wall_mesh := MeshInstance3D.new()
		var box := BoxMesh.new()
		box.size = Vector3(float(seg["length"]), WALL_HEIGHT, WALL_THICKNESS)
		wall_mesh.mesh = box
		wall_mesh.transform = seg["transform"]
		wall_mesh.material_override = _wall_material
		tile.add_child(wall_mesh)

func _ensure_wall_material() -> void:
	if _wall_material != null:
		return
	_wall_material = ShaderMaterial.new()
	_wall_material.shader = WALL_SHADER
	# half_height: box is centered on its origin so its bottom face is at
	# -WALL_HEIGHT/2; the shader measures strip height up from the floor. The
	# strip placement defaults in the shader read as a crisp low LED line, so we
	# only need to seed the tint here.
	_wall_material.set_shader_parameter("half_height", WALL_HEIGHT * 0.5)
	_wall_material.set_shader_parameter("tint_color", TINT_NEUTRAL)

# Pure phase-name -> tint Color mapping. Static so it can be unit-tested
# without a scene tree. Unknown / lobby / filling / free_roam all read neutral.
static func tint_for_phase(phase_name: String) -> Color:
	match phase_name:
		"turn_clown":
			return TINT_CLOWN
		"turn_mime":
			return TINT_MIME
		_:
			return TINT_NEUTRAL

## Crossfade the wall uplight tint to the color for `phase_name`. Both the
## online (arena.gd) and offline (offline_mode.gd) phase handlers route here so
## the mapping lives in one place. A Tween writes the shared material's uniform
## once per frame during the fade - no node churn.
func set_phase_tint(phase_name: String) -> void:
	if _wall_material == null:
		return
	var target: Color = tint_for_phase(phase_name)
	if _tint_tween != null and _tint_tween.is_valid():
		_tint_tween.kill()
	var from: Color = _wall_material.get_shader_parameter("tint_color")
	_tint_tween = create_tween()
	_tint_tween.tween_method(
		func(c: Color): _wall_material.set_shader_parameter("tint_color", c),
		from,
		target,
		TINT_FADE_S,
	)

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
	# Klein's playfield is the double cover: 2*WIDTH along x, WIDTH along z.
	# Every other topology stays square.
	var ext_x: float = topology.extent_x() if topology != null else TopologyScript.WIDTH
	var ext_z: float = topology.extent_z() if topology != null else TopologyScript.WIDTH
	plane.size = Vector2(ext_x, ext_z)
	floor_node.mesh = plane
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.13, 0.14, 0.17)
	mat.roughness = 0.85
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
	mesh_node.material_override = _wall_material
	body.add_child(mesh_node)
	var collider := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = Vector3(seg_length, WALL_HEIGHT, WALL_THICKNESS)
	collider.shape = shape
	body.add_child(collider)
	return body
