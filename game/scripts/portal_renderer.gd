extends RefCounted

## Renders server-authoritative portal pairs as pooled glowing rings under the
## arena's World node. Same pattern as item_renderer.gd / projectile_renderer.gd:
## constructed with the arena, reads arena.world / arena.topology /
## arena.local_player, owns no scene-tree lifecycle of its own.
##
## A portal is a pair of wall-anchored mouths (a, b); each pool slot owns two
## upright ring meshes. Portals ride the snapshot (live pairs reconciled by
## render_from_snapshot), and portal_open / portal_close events show/hide one the
## instant the server reports it. tick() spins and pulses each live ring and
## reprojects both mouths to their wrap-nearest copy so a pair across a
## torus/klein/möbius seam doesn't render on the far side of the map.
##
## Geometry is server-only: the client renders the two wire points verbatim and
## never recomputes mouth placement. No per-event add_child/queue_free: the ring
## pool is allocated once; open/close only flip visibility and rewrite transforms.

# A handful of pairs is live at once (6 s lifetime, one per use). 8 pairs of two
# mouths each is ample; an open beyond the pool is dropped rather than evicting a
# live pair.
const MAX_PAIRS := 8

const MOUTH_HEIGHT := 1.6
const RING_OUTER := 1.2
const RING_INNER := 0.95
const PULSE_SPEED := 3.0
const PULSE_AMPLITUDE := 0.12
const EMISSION_BASE := 2.0
const EMISSION_PULSE := 1.0
const PORTAL_COLOR := Color(0.6, 0.4, 1.0)
# The mouth sits on a wall centerline (walls are WALL_THICKNESS thick and solid),
# so the ring is offset toward the local camera to clear the wall face and read
# as a hoop standing in front of the wall on the viewer's side rather than buried
# inside it. Each client offsets toward its own camera, so two players on
# opposite sides of a wall each see a mouth facing them.
const FACE_OFFSET := 0.55

var _arena: Object
# slot -> {a_root: Node3D, b_root: Node3D}
var _pool: Array = []
var _material: StandardMaterial3D
# id -> {slot:int, a_canonical:Vector3, b_canonical:Vector3}
var _active: Dictionary = {}
# Slot indices not currently bound to a portal id.
var _free_slots: Array[int] = []
var _pulse_phase: float = 0.0

func _init(arena: Object) -> void:
	_arena = arena
	_material = StandardMaterial3D.new()
	_material.albedo_color = PORTAL_COLOR
	_material.emission_enabled = true
	_material.emission = PORTAL_COLOR
	_material.emission_energy_multiplier = 2.0
	var ring_mesh := TorusMesh.new()
	ring_mesh.inner_radius = RING_INNER
	ring_mesh.outer_radius = RING_OUTER
	var world: Node3D = _arena.world
	for i in MAX_PAIRS:
		var a_root := _make_mouth(ring_mesh)
		var b_root := _make_mouth(ring_mesh)
		world.add_child(a_root)
		world.add_child(b_root)
		_pool.append({"a_root": a_root, "b_root": b_root})
		_free_slots.append(i)

# The ring stays at the root's local origin; the root's basis is rebuilt each
# tick so the torus axis points at the viewer (a vertical hoop facing them).
func _make_mouth(ring_mesh: TorusMesh) -> Node3D:
	var root := Node3D.new()
	root.visible = false
	var ring := MeshInstance3D.new()
	ring.mesh = ring_mesh
	ring.material_override = _material
	ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	root.add_child(ring)
	return root

## Reconcile the rendered set with the authoritative portal list from a snapshot.
func render_from_snapshot(portals: Array) -> void:
	var seen: Dictionary = {}
	for entry in portals:
		var id: String = entry.get("id", "")
		if id.is_empty():
			continue
		seen[id] = true
		_upsert(entry)
	for id in _active.keys():
		if not seen.has(id):
			_release(id)

## Show a pair the instant the server opens it (portal_open event).
func on_open(portal: Dictionary) -> void:
	if not portal.is_empty():
		_upsert(portal)

## Hide a pair the instant the server closes it (portal_close event).
func on_close(id: String) -> void:
	if not id.is_empty():
		_release(id)

## Pulse every live ring (a breathing glow + gentle scale) and reproject both
## mouths to their wrap-nearest copy so a seam crossing doesn't teleport them.
## The ring is held flush with the wall it sits on (never billboarded/tilted)
## and offset onto whichever face the viewer is on. No spin: the ring stands
## upright on the wall face, so spinning it would sweep it through the wall.
## Cheap writes; runs at render rate for smooth motion between state changes.
func tick(_delta: float) -> void:
	if _active.is_empty():
		return
	_pulse_phase += _delta * PULSE_SPEED
	var wave := sin(_pulse_phase)
	_material.emission_energy_multiplier = EMISSION_BASE + wave * EMISSION_PULSE
	var scale := 1.0 + wave * PULSE_AMPLITUDE
	for id in _active:
		var entry: Dictionary = _pool[_active[id]["slot"]]
		_place_mouth(entry["a_root"], _active[id]["a_canonical"], _active[id]["a_normal"], scale)
		_place_mouth(entry["b_root"], _active[id]["b_canonical"], _active[id]["b_normal"], scale)

func _place_mouth(root: Node3D, canonical: Vector3, normal: Vector3, scale: float) -> void:
	var near := _to_camera_nearest_copy(canonical)
	var base := Vector3(near.x, MOUTH_HEIGHT, near.z)
	var to_cam := _camera_horizontal_dir(base)
	# Aim the torus axis along the wall normal so the ring's plane stays flush
	# with the wall, then flip it to the face the viewer is on and offset it that
	# far off the centerline so it clears the solid wall. When no wall is found
	# (shouldn't happen for a wall-anchored mouth) fall back to facing the camera.
	var axis := to_cam
	if normal != Vector3.ZERO:
		axis = normal if normal.dot(to_cam) >= 0.0 else -normal
	root.global_transform = Transform3D(
		_facing_basis(axis).scaled(Vector3(scale, scale, scale)), base + axis * FACE_OFFSET
	)

## Hide all rings and reclaim every slot. Called on match (re)start.
func clear() -> void:
	for id in _active.keys():
		_release(id)

func _upsert(entry: Dictionary) -> void:
	var id: String = entry.get("id", "")
	if id.is_empty():
		return
	var a_canonical := _read_vec3(entry.get("a", {}))
	var b_canonical := _read_vec3(entry.get("b", {}))
	var slot: int
	if _active.has(id):
		slot = _active[id]["slot"]
	elif not _free_slots.is_empty():
		slot = _free_slots.pop_back()
	else:
		# Pool exhausted (shouldn't happen at MAX_PAIRS headroom). Drop the open
		# rather than evict a live pair arbitrarily.
		return
	# Walls are static, so resolve each mouth's wall normal once here and cache it.
	var a_normal := _wall_normal_at(a_canonical)
	var b_normal := _wall_normal_at(b_canonical)
	_active[id] = {
		"slot": slot,
		"a_canonical": a_canonical,
		"b_canonical": b_canonical,
		"a_normal": a_normal,
		"b_normal": b_normal,
	}
	var pool_entry: Dictionary = _pool[slot]
	# Place once now so the pair is correct the frame it opens; tick() refines it
	# as the camera moves.
	_place_mouth(pool_entry["a_root"], a_canonical, a_normal, 1.0)
	_place_mouth(pool_entry["b_root"], b_canonical, b_normal, 1.0)
	pool_entry["a_root"].visible = true
	pool_entry["b_root"].visible = true

func _release(id: String) -> void:
	if not _active.has(id):
		return
	var slot: int = _active[id]["slot"]
	_pool[slot]["a_root"].visible = false
	_pool[slot]["b_root"].visible = false
	_free_slots.append(slot)
	_active.erase(id)

func _read_vec3(d: Dictionary) -> Vector3:
	return Vector3(float(d.get("x", 0.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0)))

# Horizontal unit normal of the wall the mouth sits on (the mouth is anchored on
# a wall centerline, so the nearest segment is that wall). Vector3.ZERO when no
# walls are known. Reads the same {ax,az,bx,bz} endpoints the predictor uses.
func _wall_normal_at(point: Vector3) -> Vector3:
	var lab: Object = _arena.labyrinth
	if lab == null:
		return Vector3.ZERO
	var endpoints: Array = lab.wall_endpoints()
	var best := Vector3.ZERO
	var best_d := INF
	for w in endpoints:
		var ax: float = w["ax"]
		var az: float = w["az"]
		var bx: float = w["bx"]
		var bz: float = w["bz"]
		var dx := bx - ax
		var dz := bz - az
		var len_sq := dx * dx + dz * dz
		var t := 0.0
		if len_sq > 0.000001:
			t = clampf(((point.x - ax) * dx + (point.z - az) * dz) / len_sq, 0.0, 1.0)
		var cx := ax + dx * t
		var cz := az + dz * t
		var d := Vector2(point.x - cx, point.z - cz).length_squared()
		if d < best_d:
			best_d = d
			var n := Vector3(-dz, 0.0, dx)
			best = n.normalized() if n.length() > 0.000001 else Vector3.ZERO
	return best

# Horizontal unit vector from a world point toward the local camera. Defaults to
# +Z when the camera is unavailable or directly overhead.
func _camera_horizontal_dir(from: Vector3) -> Vector3:
	var local: Node = _arena.local_player
	if local == null:
		return Vector3(0, 0, 1)
	var d: Vector3 = local.global_position - from
	d.y = 0.0
	if d.length() < 0.0001:
		return Vector3(0, 0, 1)
	return d.normalized()

# Orthonormal basis whose +Y (the torus axis) points along `axis`, so the ring's
# plane is perpendicular to it -- a vertical hoop facing whatever `axis` points
# at. The torus is rotationally symmetric, so the in-plane axes are arbitrary.
func _facing_basis(axis: Vector3) -> Basis:
	var y := axis.normalized()
	var x := Vector3.UP.cross(y)
	if x.length() < 0.0001:
		x = Vector3.RIGHT
	x = x.normalized()
	var z := x.cross(y)
	return Basis(x, y, z)

# Mirror of player.gd / item_renderer.gd: render the canonical position at the
# wrap-equivalent copy nearest the local camera so a mouth near a seam reads on
# the near side. Y is replaced by MOUTH_HEIGHT, so only X/Z matter here.
func _to_camera_nearest_copy(canonical: Vector3) -> Vector3:
	var topology: Object = _arena.topology
	var local: Node = _arena.local_player
	if topology == null or local == null:
		return canonical
	var camera_pos: Vector3 = local.global_position
	var planar_offset: Vector3 = topology.delta(camera_pos, canonical)
	return Vector3(camera_pos.x + planar_offset.x, canonical.y, camera_pos.z + planar_offset.z)
