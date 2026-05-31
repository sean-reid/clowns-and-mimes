extends "res://tests/test_case.gd"

## White-box tests for item_renderer.gd. Items are static between pickups, so
## the renderer reconciles against the snapshot list (render_from_snapshot) and
## flips single icons on item_spawn / item_pickup. Like the projectile test, a
## tiny MockArena stands in for arena.gd; the runner executes before the tree is
## running, so assertions target the renderer's tracked state + visibility
## flags rather than resolved world transforms.

const ItemRenderer := preload("res://scripts/item_renderer.gd")
const ItemVisuals := preload("res://scripts/item_visuals.gd")
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

static func _item(id: String, type: String, pos: Vector3) -> Dictionary:
	return {"id": id, "type": type, "position": {"x": pos.x, "y": pos.y, "z": pos.z}}

func test_snapshot_spawns_visible_icon_at_canonical() -> void:
	var a := _make_arena()
	var r := ItemRenderer.new(a)
	r.render_from_snapshot([_item("i-3", "surge", Vector3(5, 0, -2))])
	assert_true(r._active.has("i-3"), "i-3 tracked after snapshot")
	var slot: int = r._active["i-3"]["slot"]
	assert_true(r._pool[slot]["root"].visible, "icon root visible")
	var canonical: Vector3 = r._active["i-3"]["canonical"]
	assert_approx(canonical.x, 5.0, 0.001, "x at canonical")
	assert_approx(canonical.z, -2.0, 0.001, "z at canonical")
	_free_arena(a)

func test_snapshot_releases_absent_items() -> void:
	var a := _make_arena()
	var r := ItemRenderer.new(a)
	r.render_from_snapshot([_item("i-1", "radar", Vector3.ZERO)])
	var slot: int = r._active["i-1"]["slot"]
	r.render_from_snapshot([])
	assert_false(r._active.has("i-1"), "i-1 dropped when absent from snapshot")
	assert_false(r._pool[slot]["root"].visible, "freed slot hidden")
	_free_arena(a)

func test_on_pickup_hides_immediately() -> void:
	var a := _make_arena()
	var r := ItemRenderer.new(a)
	r.render_from_snapshot([_item("i-7", "leap", Vector3.ZERO)])
	assert_true(r._active.has("i-7"), "item tracked")
	r.on_pickup("i-7")
	assert_false(r._active.has("i-7"), "picked-up item dropped")
	_free_arena(a)

func test_on_spawn_adds_single_item() -> void:
	var a := _make_arena()
	var r := ItemRenderer.new(a)
	r.on_spawn(_item("i-9", "cloak", Vector3(1, 0, 1)))
	assert_true(r._active.has("i-9"), "respawned item tracked")
	_free_arena(a)

func test_slot_reused_after_release() -> void:
	var a := _make_arena()
	var r := ItemRenderer.new(a)
	var free_before: int = r._free_slots.size()
	r.on_spawn(_item("i-2", "portal", Vector3.ZERO))
	r.on_pickup("i-2")
	assert_eq(r._free_slots.size(), free_before, "slot returned to the free pool")
	_free_arena(a)

func test_category_color_mapping() -> void:
	# The shared visuals map drives both the world icon and the HUD slot, so
	# guard the category assignments the renderer tints by.
	assert_eq(ItemVisuals.category("leap"), "movement", "leap is movement")
	assert_eq(ItemVisuals.category("surge"), "combat", "surge is combat")
	assert_eq(ItemVisuals.category("radar"), "info", "radar is info")
	assert_eq(ItemVisuals.category("cloak"), "defense", "cloak is defense")

func test_shape_distinguishes_same_category_types() -> void:
	# Category color can't tell apart the two types in each family; the shape
	# must. Guard that same-category pairs get different shapes.
	assert_true(ItemVisuals.shape("leap") != ItemVisuals.shape("portal"), "movement pair differs")
	assert_true(ItemVisuals.shape("surge") != ItemVisuals.shape("overcharge"), "combat pair differs")
	assert_true(ItemVisuals.shape("cloak") != ItemVisuals.shape("clone"), "defense pair differs")

func test_upsert_assigns_per_type_mesh() -> void:
	var a := _make_arena()
	var r := ItemRenderer.new(a)
	r.render_from_snapshot([_item("i-p", "portal", Vector3.ZERO)])
	var portal_slot: int = r._active["i-p"]["slot"]
	assert_true(r._pool[portal_slot]["icon"].mesh is TorusMesh, "portal renders as a torus")
	r.render_from_snapshot([_item("i-l", "leap", Vector3(2, 0, 0))])
	var leap_slot: int = r._active["i-l"]["slot"]
	assert_true(r._pool[leap_slot]["icon"].mesh is PrismMesh, "leap renders as a prism")
	_free_arena(a)
