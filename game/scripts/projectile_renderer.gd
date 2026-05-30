extends RefCounted

## Renders server-authoritative projectiles as pooled glowing spheres under
## the arena's World node. Lifted out of arena.gd the same way ContactInteractions
## and OnlinePredictor are: constructed with the arena, reads arena.world /
## arena.topology / arena.local_player, owns no scene-tree lifecycle of its own.
##
## The server is the only source of truth. Each delta carries the live
## projectile set (render_from_delta upserts present ids, hides absent ones);
## projectile_fired spawns one instantly for snappy local feedback ahead of the
## next delta; projectile_hit hides one immediately. Between deltas, tick()
## dead-reckons each sphere along its server-sent velocity so motion stays smooth
## on monitors faster than the 60 Hz delta cadence.
##
## No per-event add_child/queue_free: the sphere pool is allocated once. A burst
## of fire/hit events only flips visibility and rewrites transforms.

const SharedConstants := preload("res://scripts/shared_constants.gd")

# Headroom for in-flight projectiles. Cooldown 1.5 s vs lifetime 2.5 s caps a
# single shooter near 2 live; a full lobby (~10) tops out around 20. 32 leaves
# margin so a fired sphere is never dropped for lack of a slot.
const MAX_PROJECTILES := 32
const PROJECTILE_RADIUS := SharedConstants.PROJECTILE_RADIUS

# Bright, emissive team tints so a projectile reads against either arena
# palette. Distinct from player.gd's darker BACK colors (different visual role).
const MIME_COLOR := Color(0.9, 0.95, 1.0)
const CLOWN_COLOR := Color(1.0, 0.35, 0.3)

var _arena: Object
var _pool: Array[MeshInstance3D] = []
var _mime_material: StandardMaterial3D
var _clown_material: StandardMaterial3D
# id -> {slot:int, canonical:Vector3, velocity:Vector3}
var _active: Dictionary = {}
# Slot indices not currently bound to a projectile id.
var _free_slots: Array[int] = []

func _init(arena: Object) -> void:
	_arena = arena
	_mime_material = _make_material(MIME_COLOR)
	_clown_material = _make_material(CLOWN_COLOR)
	var mesh := SphereMesh.new()
	mesh.radius = PROJECTILE_RADIUS
	mesh.height = PROJECTILE_RADIUS * 2.0
	var world: Node3D = _arena.world
	for i in MAX_PROJECTILES:
		var inst := MeshInstance3D.new()
		inst.mesh = mesh
		inst.visible = false
		# Projectiles are pure visuals; never let them cast/receive collision
		# work and skip shadow passes to keep the burst cheap.
		inst.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		world.add_child(inst)
		_pool.append(inst)
		_free_slots.append(i)

func _make_material(color: Color) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	mat.emission_enabled = true
	mat.emission = color
	mat.emission_energy_multiplier = 2.0
	return mat

## Reconcile the rendered set with the authoritative list from a delta.
func render_from_delta(projectiles: Array) -> void:
	var seen: Dictionary = {}
	for entry in projectiles:
		var id: String = entry.get("id", "")
		if id.is_empty():
			continue
		seen[id] = true
		_upsert(entry)
	for id in _active.keys():
		if not seen.has(id):
			_release(id)

## Spawn (or refresh) a single projectile immediately, e.g. on projectile_fired
## so the shooter sees their shot without waiting for the next delta.
func on_fired(projectile: Dictionary) -> void:
	if projectile.is_empty():
		return
	_upsert(projectile)

## Hide a projectile the instant the server reports it terminated.
func on_hit(projectile_id: String) -> void:
	if not projectile_id.is_empty():
		_release(projectile_id)

## Advance every live sphere along its velocity since the last server update so
## rendering stays smooth between 60 Hz deltas. The next delta snaps it back to
## the authoritative position.
func tick(delta: float) -> void:
	if _active.is_empty():
		return
	for id in _active:
		var state: Dictionary = _active[id]
		var canonical: Vector3 = state["canonical"] + state["velocity"] * delta
		canonical = _arena.topology.wrap(canonical) if _arena.topology != null else canonical
		state["canonical"] = canonical
		_pool[state["slot"]].global_position = _to_camera_nearest_copy(canonical)

## Hide all spheres and reclaim every slot. Called on match (re)start.
func clear() -> void:
	for id in _active.keys():
		_release(id)

func _upsert(entry: Dictionary) -> void:
	var id: String = entry.get("id", "")
	if id.is_empty():
		return
	var canonical := _read_vec3(entry.get("position", {}))
	var velocity := _read_vec3(entry.get("velocity", {}))
	var slot: int
	if _active.has(id):
		slot = _active[id]["slot"]
	elif not _free_slots.is_empty():
		slot = _free_slots.pop_back()
	else:
		# Pool exhausted (shouldn't happen at MAX_PROJECTILES headroom).
		# Drop the spawn rather than evict a live sphere arbitrarily.
		return
	_active[id] = {"slot": slot, "canonical": canonical, "velocity": velocity}
	var inst := _pool[slot]
	inst.material_override = _clown_material if entry.get("team", "") == "clown" else _mime_material
	inst.global_position = _to_camera_nearest_copy(canonical)
	inst.visible = true

func _release(id: String) -> void:
	if not _active.has(id):
		return
	var slot: int = _active[id]["slot"]
	_pool[slot].visible = false
	_free_slots.append(slot)
	_active.erase(id)

func _read_vec3(d: Dictionary) -> Vector3:
	return Vector3(float(d.get("x", 0.0)), float(d.get("y", 0.0)), float(d.get("z", 0.0)))

# Mirror of player.gd::_to_camera_nearest_copy: render the canonical position at
# the wrap-equivalent copy nearest the local camera so a projectile crossing a
# torus/klein/möbius seam doesn't visually teleport. Y is preserved verbatim
# because topology.delta zeroes Y (wrapping is planar).
func _to_camera_nearest_copy(canonical: Vector3) -> Vector3:
	var topology: Object = _arena.topology
	var local: Node = _arena.local_player
	if topology == null or local == null:
		return canonical
	var camera_pos: Vector3 = local.global_position
	var planar_offset: Vector3 = topology.delta(camera_pos, canonical)
	return Vector3(camera_pos.x + planar_offset.x, canonical.y, camera_pos.z + planar_offset.z)
