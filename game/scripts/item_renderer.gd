extends RefCounted

## Renders server-authoritative power-up items as pooled floating icons under
## the arena's World node. Same pattern as projectile_renderer.gd: constructed
## with the arena, reads arena.world / arena.topology / arena.local_player, owns
## no scene-tree lifecycle of its own.
##
## Items are static between pickups, so they ride the snapshot rather than the
## per-tick delta. render_from_snapshot reconciles the rendered set against the
## authoritative list; on_spawn adds one when its respawn timer elapses;
## on_pickup hides one the instant the server reports it grabbed. tick() runs a
## slow vertical bob and spin, and recomputes each icon's wrap-nearest copy so
## items across a torus/klein/möbius seam don't render on the far side of the
## map. Each icon sits over a faint emission ring so it reads in fog.
##
## No per-event add_child/queue_free: the icon pool is allocated once. Spawn and
## pickup events only flip visibility and rewrite transforms.

const ItemVisuals := preload("res://scripts/item_visuals.gd")

# One icon per floor cell at most: plane/torus are 100 cells, klein/möbius 200,
# minus the few excluded spawn/centroid cells. 200 covers every topology; a
# spawn beyond the pool is dropped rather than evicting a live icon.
const MAX_ITEMS := 200

# Bob: the icon rises/falls BOB_AMPLITUDE around REST_HEIGHT at BOB_SPEED rad/s.
# A per-slot phase offset keeps the field from bobbing in lockstep.
const REST_HEIGHT := 1.2
const BOB_AMPLITUDE := 0.22
const BOB_SPEED := 2.0
const SPIN_SPEED := 1.0
const ICON_SIZE := 0.55
const RING_OUTER := 0.85
const RING_INNER := 0.7

var _arena: Object
# slot -> {root: Node3D, icon: MeshInstance3D, ring: MeshInstance3D}
var _pool: Array = []
# category name -> StandardMaterial3D
var _materials: Dictionary = {}
# shape name (item_visuals._SHAPE) -> Mesh, shared across slots of that shape.
var _meshes: Dictionary = {}
# id -> {slot:int, canonical:Vector3}
var _active: Dictionary = {}
# Slot indices not currently bound to an item id.
var _free_slots: Array[int] = []
var _bob_phase: float = 0.0

func _init(arena: Object) -> void:
	_arena = arena
	for cat in ["movement", "combat", "info", "defense"]:
		_materials[cat] = _make_material(ItemVisuals._COLOR[cat])
	for shape in ["cube", "sphere", "octahedron", "cylinder", "prism", "capsule", "torus"]:
		_meshes[shape] = _build_mesh(shape)
	var ring_mesh := TorusMesh.new()
	ring_mesh.inner_radius = RING_INNER
	ring_mesh.outer_radius = RING_OUTER
	var world: Node3D = _arena.world
	for i in MAX_ITEMS:
		var root := Node3D.new()
		root.visible = false
		var icon := MeshInstance3D.new()
		icon.mesh = _meshes["cube"]
		icon.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		icon.position = Vector3(0.0, REST_HEIGHT, 0.0)
		var ring := MeshInstance3D.new()
		ring.mesh = ring_mesh
		ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		root.add_child(icon)
		root.add_child(ring)
		world.add_child(root)
		_pool.append({"root": root, "icon": icon, "ring": ring})
		_free_slots.append(i)

# Build one built-in primitive per shape key, all sized to ~ICON_SIZE so they
# read at the same scale. "octahedron" is a low-segment sphere, which Godot
# tessellates into a faceted diamond - distinct from the smooth "sphere".
func _build_mesh(shape: String) -> Mesh:
	var half := ICON_SIZE * 0.5
	match shape:
		"sphere":
			var m := SphereMesh.new()
			m.radius = half
			m.height = ICON_SIZE
			return m
		"octahedron":
			var m := SphereMesh.new()
			m.radius = half
			m.height = ICON_SIZE
			m.radial_segments = 4
			m.rings = 2
			return m
		"cylinder":
			var m := CylinderMesh.new()
			m.top_radius = half
			m.bottom_radius = half
			m.height = ICON_SIZE
			return m
		"prism":
			var m := PrismMesh.new()
			m.size = Vector3(ICON_SIZE, ICON_SIZE, ICON_SIZE)
			return m
		"capsule":
			var m := CapsuleMesh.new()
			m.radius = half * 0.7
			m.height = ICON_SIZE
			return m
		"torus":
			var m := TorusMesh.new()
			m.inner_radius = half * 0.5
			m.outer_radius = half
			return m
		_:
			var m := BoxMesh.new()
			m.size = Vector3(ICON_SIZE, ICON_SIZE, ICON_SIZE)
			return m

func _make_material(color: Color) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.emission_enabled = true
	mat.emission = color
	mat.emission_energy_multiplier = 1.5
	return mat

## Reconcile the rendered set with the authoritative item list from a snapshot.
func render_from_snapshot(items: Array) -> void:
	var seen: Dictionary = {}
	for entry in items:
		var id: String = entry.get("id", "")
		if id.is_empty():
			continue
		seen[id] = true
		_upsert(entry)
	for id in _active.keys():
		if not seen.has(id):
			_release(id)

## Show a single item the instant the server respawns it (item_spawn event).
func on_spawn(item: Dictionary) -> void:
	if not item.is_empty():
		_upsert(item)

## Hide an item the instant the server reports it picked up (item_pickup event).
func on_pickup(item_id: String) -> void:
	if not item_id.is_empty():
		_release(item_id)

## Bob + spin every live icon and reproject it to the wrap-nearest copy so a
## seam crossing doesn't teleport it. Cheap transform writes; runs at render
## rate for smooth motion between the (infrequent) item state changes.
func tick(delta: float) -> void:
	if _active.is_empty():
		return
	_bob_phase += delta * BOB_SPEED
	for id in _active:
		var state: Dictionary = _active[id]
		var slot: int = state["slot"]
		var entry: Dictionary = _pool[slot]
		var root: Node3D = entry["root"]
		root.global_position = _to_camera_nearest_copy(state["canonical"])
		var icon: MeshInstance3D = entry["icon"]
		icon.position.y = REST_HEIGHT + sin(_bob_phase + float(slot)) * BOB_AMPLITUDE
		icon.rotate_y(delta * SPIN_SPEED)

## Hide all icons and reclaim every slot. Called on match (re)start.
func clear() -> void:
	for id in _active.keys():
		_release(id)

func _upsert(entry: Dictionary) -> void:
	var id: String = entry.get("id", "")
	if id.is_empty():
		return
	var canonical := _read_vec3(entry.get("position", {}))
	var slot: int
	if _active.has(id):
		slot = _active[id]["slot"]
	elif not _free_slots.is_empty():
		slot = _free_slots.pop_back()
	else:
		# Pool exhausted (shouldn't happen at MAX_ITEMS headroom). Drop the
		# spawn rather than evict a live icon arbitrarily.
		return
	_active[id] = {"slot": slot, "canonical": canonical}
	var pool_entry: Dictionary = _pool[slot]
	var item_type: String = entry.get("type", "")
	var mat: StandardMaterial3D = _materials[ItemVisuals.category(item_type)]
	pool_entry["icon"].mesh = _meshes[ItemVisuals.shape(item_type)]
	pool_entry["icon"].material_override = mat
	pool_entry["ring"].material_override = mat
	pool_entry["root"].global_position = _to_camera_nearest_copy(canonical)
	pool_entry["root"].visible = true

func _release(id: String) -> void:
	if not _active.has(id):
		return
	var slot: int = _active[id]["slot"]
	_pool[slot]["root"].visible = false
	_free_slots.append(slot)
	_active.erase(id)

func _read_vec3(d: Dictionary) -> Vector3:
	return Vector3(float(d.get("x", 0.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0)))

# Mirror of player.gd / projectile_renderer.gd: render the canonical position at
# the wrap-equivalent copy nearest the local camera so an item near a seam reads
# on the near side. Y is preserved verbatim because topology.delta zeroes Y.
func _to_camera_nearest_copy(canonical: Vector3) -> Vector3:
	var topology: Object = _arena.topology
	var local: Node = _arena.local_player
	if topology == null or local == null:
		return canonical
	var camera_pos: Vector3 = local.global_position
	var planar_offset: Vector3 = topology.delta(camera_pos, canonical)
	return Vector3(camera_pos.x + planar_offset.x, canonical.y, camera_pos.z + planar_offset.z)
