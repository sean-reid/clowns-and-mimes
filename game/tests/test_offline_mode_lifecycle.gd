extends "res://tests/test_case.gd"

## Offline_mode glue coverage: the per-type item-effect dispatch and the portal
## teleport lifecycle. These run live in a match and have no cross-language
## fixture (the pure pieces - item layout, projectile flight, portal geometry -
## are fixtured elsewhere); this locks the offline-only orchestration so a
## regression in effect wiring or the portal state machine is caught in CI.
##
## Bodies are stub Node3Ds (offline_mode types them as Node). They're left at
## the origin - an out-of-tree Node3D reports global_position as zero, which we
## lean on rather than fight: the portal mouth is placed at the origin so the
## contact check fires without needing a live global transform.

const OfflineMode := preload("res://scripts/offline_mode.gd")
const OfflineItems := preload("res://scripts/offline_items.gd")
const OfflinePortals := preload("res://scripts/offline_portals.gd")
const GameRules := preload("res://scripts/game_rules.gd")
const PlaneTopology := preload("res://scripts/topology/plane_topology.gd")

class FakeBody:
	extends Node3D
	var cloak_until_ms: int = 0
	var leap_armed: bool = false
	var surge_until_ms: int = 0

class FakeArena:
	extends Node
	var player_nodes: Dictionary = {}
	var topology
	var rules
	var portal_renderer = null
	var item_renderer = null

func _make() -> Array:
	var arena := FakeArena.new()
	arena.topology = PlaneTopology.new()
	arena.rules = GameRules.new()
	var offline = OfflineMode.new()
	offline.arena = arena
	return [offline, arena]

func _teardown(offline: Node, arena: Node) -> void:
	for body in arena.player_nodes.values():
		body.free()
	if arena.rules != null:
		arena.rules.free()
	arena.free()
	offline.free()

func test_item_effects_apply_to_body_and_rules() -> void:
	var made := _make()
	var offline = made[0]
	var arena = made[1]
	arena.rules.register_player("p", "mime", Vector3.ZERO, "P", false)
	var body := FakeBody.new()
	arena.player_nodes["p"] = body

	offline._apply_item_effect(body, "cloak", "p")
	assert_true(body.cloak_until_ms > 0, "cloak sets cloak_until_ms")

	offline._apply_item_effect(body, "leap", "p")
	assert_true(body.leap_armed, "leap arms the body")

	offline._apply_item_effect(body, "surge", "p")
	assert_true(body.surge_until_ms > 0, "surge sets surge_until_ms")

	offline._apply_item_effect(body, "radar", "p")
	assert_true(arena.rules.players["p"].has("radarUntil"), "radar sets radarUntil on the rules dict")

	offline._apply_item_effect(body, "overcharge", "p")
	assert_true(arena.rules.players["p"].get("overchargeArmed", false), "overcharge arms the next shot")

	_teardown(offline, arena)

# Portal whose entry mouth sits at the origin (where a stub body reads), with the
# exit elsewhere. expires_at defaults to the future.
func _portal_geom(now_ms: int) -> Dictionary:
	return {
		"id": "portal_test",
		"a": Vector3(0.0, 0.0, 0.0),
		"b": Vector3(-20.0, 0.0, 0.0),
		"a_exit": Vector3(-30.0, 0.0, 0.0),
		"b_exit": Vector3(20.0, 0.0, 0.0),
		"a_exit_yaw": 0.0,
		"b_exit_yaw": 0.0,
		"owner": "p",
		"expires_at": now_ms + OfflinePortals.PORTAL_DURATION_MS,
	}

func test_portal_teleports_on_contact() -> void:
	var made := _make()
	var offline = made[0]
	var arena = made[1]
	arena.player_nodes["p"] = FakeBody.new()  # at the origin, on mouth a
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	offline._portals = [_portal_geom(now_ms)]

	# Standing on a live mouth, off cooldown and not blocked -> teleport fires,
	# which records the opener block + per-player cooldown.
	offline._step_portals(0.016)
	assert_true(offline._portal_blocked.has("p"), "opener blocked after teleport")
	assert_true(offline._portal_cooldown.has("p"), "teleport cooldown recorded")

	_teardown(offline, arena)

func test_portal_expires_and_clears_state() -> void:
	var made := _make()
	var offline = made[0]
	var arena = made[1]
	arena.player_nodes["p"] = FakeBody.new()
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	var geom := _portal_geom(now_ms)
	geom["expires_at"] = now_ms - 1000  # already elapsed
	offline._portals = [geom]
	offline._portal_blocked["p"] = true

	offline._step_portals(0.016)
	assert_eq(offline._portals.size(), 0, "expired portal removed")
	assert_false(offline._portal_blocked.has("p"), "blocked state cleared when no portals remain")

	_teardown(offline, arena)
