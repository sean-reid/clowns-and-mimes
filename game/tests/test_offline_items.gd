extends "res://tests/test_case.gd"

## Item lifecycle (pickup / respawn / use), mirrors itemManager.test.ts. The
## deterministic layout + rotation are checked against the TS-generated fixture
## in test_offline_items_determinism.gd, so they're not re-asserted here.

const OfflineItems := preload("res://scripts/offline_items.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

var _topo := PlaneTopology.new()

func test_pickup_assigns_and_removes_from_floor() -> void:
	var items := OfflineItems.new()
	items.spawn(999, "plane")
	var target: Dictionary = items.available()[0]
	var p := {"id": "p", "team": "mime", "position": target.position, "frozen": false}
	var events: Array = items.step(0, [p], _topo)
	assert_eq(p.get("active_item", ""), target.type, "player now holds the item type")
	assert_eq(events.size(), 1, "one pickup event")
	var still_there := false
	for it in items.available():
		if it.id == target.id:
			still_there = true
	assert_false(still_there, "item left the floor")

func test_no_pickup_while_holding_or_frozen() -> void:
	var items := OfflineItems.new()
	items.spawn(999, "plane")
	var target: Dictionary = items.available()[0]
	var holding := {"id": "h", "team": "mime", "position": target.position, "active_item": "surge"}
	var frozen := {"id": "f", "team": "mime", "position": target.position, "frozen": true}
	assert_eq(items.step(0, [holding, frozen], _topo).size(), 0, "neither picks up")

func test_item_respawns_after_window() -> void:
	var items := OfflineItems.new()
	items.spawn(999, "plane")
	var target: Dictionary = items.available()[0]
	var p := {"id": "p", "team": "mime", "position": target.position}
	items.step(0, [p], _topo)
	# Move the picker away so it doesn't re-grab the respawned item.
	p.position = Vector3(1000, 0, 1000)
	items.step(OfflineItems.ITEM_RESPAWN_MS + 1, [p], _topo)
	var back := false
	for it in items.available():
		if it.id == target.id:
			back = true
	assert_true(back, "item respawned after the window")

func test_use_item_clears_slot() -> void:
	var items := OfflineItems.new()
	var p := {"id": "p", "active_item": "leap"}
	assert_eq(items.use_item(p), "leap", "returns the used type")
	assert_eq(p.get("active_item", ""), "", "slot cleared")
	assert_eq(items.use_item(p), "", "empty when nothing held")
