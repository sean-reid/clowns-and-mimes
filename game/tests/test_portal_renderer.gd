extends "res://tests/test_case.gd"

## White-box tests for portal_renderer.gd. Portal pairs ride the snapshot
## (render_from_snapshot reconciles the live set) and flip on portal_open /
## portal_close. Like the item test, a tiny MockArena stands in for arena.gd; the
## runner executes before the tree is running, so assertions target the
## renderer's tracked state + visibility flags rather than resolved transforms.

const PortalRenderer := preload("res://scripts/portal_renderer.gd")
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

static func _portal(id: String, a_pos: Vector3, b_pos: Vector3) -> Dictionary:
	return {
		"id": id,
		"a": {"x": a_pos.x, "y": a_pos.y, "z": a_pos.z},
		"b": {"x": b_pos.x, "y": b_pos.y, "z": b_pos.z},
		"expiresAt": 0,
	}

func test_snapshot_shows_both_mouths() -> void:
	var a := _make_arena()
	var r := PortalRenderer.new(a)
	r.render_from_snapshot([_portal("p-0", Vector3(0, 0, -3), Vector3(0, 0, 10))])
	assert_true(r._active.has("p-0"), "p-0 tracked after snapshot")
	var slot: int = r._active["p-0"]["slot"]
	assert_true(r._pool[slot]["a_root"].visible, "entry mouth visible")
	assert_true(r._pool[slot]["b_root"].visible, "exit mouth visible")
	var ac: Vector3 = r._active["p-0"]["a_canonical"]
	var bc: Vector3 = r._active["p-0"]["b_canonical"]
	assert_approx(ac.z, -3.0, 0.001, "entry at canonical z")
	assert_approx(bc.z, 10.0, 0.001, "exit at canonical z")
	_free_arena(a)

func test_snapshot_releases_absent_pairs() -> void:
	var a := _make_arena()
	var r := PortalRenderer.new(a)
	r.render_from_snapshot([_portal("p-1", Vector3.ZERO, Vector3(1, 0, 1))])
	var slot: int = r._active["p-1"]["slot"]
	r.render_from_snapshot([])
	assert_false(r._active.has("p-1"), "p-1 dropped when absent from snapshot")
	assert_false(r._pool[slot]["a_root"].visible, "freed entry mouth hidden")
	assert_false(r._pool[slot]["b_root"].visible, "freed exit mouth hidden")
	_free_arena(a)

func test_on_open_adds_pair() -> void:
	var a := _make_arena()
	var r := PortalRenderer.new(a)
	r.on_open(_portal("p-2", Vector3(2, 0, 0), Vector3(-2, 0, 0)))
	assert_true(r._active.has("p-2"), "opened pair tracked")
	_free_arena(a)

func test_on_close_hides_immediately() -> void:
	var a := _make_arena()
	var r := PortalRenderer.new(a)
	r.on_open(_portal("p-3", Vector3.ZERO, Vector3(1, 0, 1)))
	assert_true(r._active.has("p-3"), "pair tracked")
	r.on_close("p-3")
	assert_false(r._active.has("p-3"), "closed pair dropped")
	_free_arena(a)

func test_slot_reused_after_close() -> void:
	var a := _make_arena()
	var r := PortalRenderer.new(a)
	var free_before: int = r._free_slots.size()
	r.on_open(_portal("p-4", Vector3.ZERO, Vector3(1, 0, 1)))
	r.on_close("p-4")
	assert_eq(r._free_slots.size(), free_before, "slot returned to the free pool")
	_free_arena(a)
