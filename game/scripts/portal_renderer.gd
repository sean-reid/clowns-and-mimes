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

const MOUTH_HEIGHT := 1.0
const RING_OUTER := 1.2
const RING_INNER := 0.95
const PULSE_SPEED := 3.0
const PULSE_AMPLITUDE := 0.12
const EMISSION_BASE := 2.0
const EMISSION_PULSE := 1.0
const PORTAL_COLOR := Color(0.6, 0.4, 1.0)

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

# An upright ring: the default TorusMesh lies flat in XZ, so rotate it to stand
# vertical and read as a doorway in the wall.
func _make_mouth(ring_mesh: TorusMesh) -> Node3D:
	var root := Node3D.new()
	root.visible = false
	var ring := MeshInstance3D.new()
	ring.mesh = ring_mesh
	ring.material_override = _material
	ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	ring.rotation.x = PI / 2.0
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
## Deliberately no spin: the ring stands upright in the wall, so rotating it
## about any in-plane axis would sweep it in and out through the wall it sits in.
## Cheap writes; runs at render rate for smooth motion between state changes.
func tick(delta: float) -> void:
	if _active.is_empty():
		return
	_pulse_phase += delta * PULSE_SPEED
	var wave := sin(_pulse_phase)
	_material.emission_energy_multiplier = EMISSION_BASE + wave * EMISSION_PULSE
	var scale := 1.0 + wave * PULSE_AMPLITUDE
	for id in _active:
		var entry: Dictionary = _pool[_active[id]["slot"]]
		_place_mouth(entry["a_root"], _active[id]["a_canonical"], scale)
		_place_mouth(entry["b_root"], _active[id]["b_canonical"], scale)

func _place_mouth(root: Node3D, canonical: Vector3, scale: float) -> void:
	var near := _to_camera_nearest_copy(canonical)
	root.global_position = Vector3(near.x, MOUTH_HEIGHT, near.z)
	root.scale = Vector3(scale, scale, scale)

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
	_active[id] = {"slot": slot, "a_canonical": a_canonical, "b_canonical": b_canonical}
	var pool_entry: Dictionary = _pool[slot]
	var a_near := _to_camera_nearest_copy(a_canonical)
	var b_near := _to_camera_nearest_copy(b_canonical)
	pool_entry["a_root"].global_position = Vector3(a_near.x, MOUTH_HEIGHT, a_near.z)
	pool_entry["b_root"].global_position = Vector3(b_near.x, MOUTH_HEIGHT, b_near.z)
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
