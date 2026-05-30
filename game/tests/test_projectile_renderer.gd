extends "res://tests/test_case.gd"

## White-box tests for projectile_renderer.gd. The renderer pools spheres under
## a World node, reads a topology, and uses local_player for camera-relative
## seam rendering, so a tiny MockArena stands in for arena.gd. The test runner
## executes in SceneTree._initialize where the tree isn't running yet, so
## node global_transforms don't resolve; assertions target the renderer's
## tracked canonical state + visibility flags (the real bookkeeping) rather
## than the final world transform, which mirrors player.gd's already-shipped
## _to_camera_nearest_copy and is exercised in play.

const ProjectileRenderer := preload("res://scripts/projectile_renderer.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

class MockArena:
	var world: Node3D
	var topology
	var local_player: Node3D

static func _make_arena() -> MockArena:
	var a := MockArena.new()
	a.world = Node3D.new()
	a.local_player = Node3D.new()
	a.topology = TopologyFactory.from_string("plane")
	return a

static func _free_arena(a: MockArena) -> void:
	a.world.free()
	a.local_player.free()

static func _projectile(id: String, team: String, pos: Vector3, vel: Vector3) -> Dictionary:
	return {
		"id": id,
		"ownerId": "owner",
		"team": team,
		"position": {"x": pos.x, "y": pos.y, "z": pos.z},
		"velocity": {"x": vel.x, "y": vel.y, "z": vel.z},
	}

func test_delta_spawns_visible_sphere_at_canonical() -> void:
	var a := _make_arena()
	var r := ProjectileRenderer.new(a)
	r.render_from_delta([_projectile("p1", "clown", Vector3(2, 0.5, -3), Vector3(12, 0, 0))])
	assert_true(r._active.has("p1"), "p1 tracked after delta")
	var slot: int = r._active["p1"]["slot"]
	assert_true(r._pool[slot].visible, "sphere visible")
	var canonical: Vector3 = r._active["p1"]["canonical"]
	assert_approx(canonical.x, 2.0, 0.001, "x at canonical")
	assert_approx(canonical.z, -3.0, 0.001, "z at canonical")
	_free_arena(a)

func test_tick_dead_reckons_along_velocity() -> void:
	var a := _make_arena()
	var r := ProjectileRenderer.new(a)
	r.render_from_delta([_projectile("p1", "mime", Vector3.ZERO, Vector3(12, 0, 0))])
	r.tick(0.1)
	# 12 m/s * 0.1 s = 1.2 m advance on x (plane wrap is identity).
	var canonical: Vector3 = r._active["p1"]["canonical"]
	assert_approx(canonical.x, 1.2, 0.001, "dead-reckoned x")
	_free_arena(a)

func test_delta_hides_absent_projectiles() -> void:
	var a := _make_arena()
	var r := ProjectileRenderer.new(a)
	r.render_from_delta([_projectile("p1", "mime", Vector3.ZERO, Vector3.ZERO)])
	var slot: int = r._active["p1"]["slot"]
	r.render_from_delta([])
	assert_false(r._active.has("p1"), "p1 dropped when absent from delta")
	assert_false(r._pool[slot].visible, "freed slot hidden")
	_free_arena(a)

func test_on_hit_hides_immediately() -> void:
	var a := _make_arena()
	var r := ProjectileRenderer.new(a)
	r.on_fired(_projectile("p1", "clown", Vector3.ZERO, Vector3.ZERO))
	assert_true(r._active.has("p1"), "fired projectile tracked")
	r.on_hit("p1")
	assert_false(r._active.has("p1"), "hit projectile dropped")
	_free_arena(a)

func test_slot_reused_after_release() -> void:
	var a := _make_arena()
	var r := ProjectileRenderer.new(a)
	var free_before: int = r._free_slots.size()
	r.on_fired(_projectile("p1", "mime", Vector3.ZERO, Vector3.ZERO))
	r.on_hit("p1")
	assert_eq(r._free_slots.size(), free_before, "slot returned to the free pool")
	_free_arena(a)
