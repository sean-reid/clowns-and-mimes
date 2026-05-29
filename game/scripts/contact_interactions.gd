extends RefCounted

## Tag + save (unfreeze) attempts driven by body-overlap checks. Extracted
## from arena.gd under Phase C3 of the file-split plan.
##
## RefCounted (no scene-tree needs): the check runs at the input cadence
## from arena._physics_process; everything else is pure state lookup.
##
## Host pattern: stores an `arena: Node` reference set at construction.
## Reads arena.local_player, arena.local_player_id, arena.player_nodes,
## arena.topology, arena.phase_label, arena.online_mode, arena.rules,
## arena.room_client; no writes.

# Distance at which a same-cell overlap triggers a tag / save attempt.
# Matches the server's tag radius so client-side prediction of contacts
# doesn't fire on misses the server would reject.
const CONTACT_RADIUS := 1.4

# Short per-target cooldown so a single physics frame doesn't fire the
# same tag twice. The server already de-dupes via its own cooldown +
# frozen-state check; a longer client gate would suppress legitimate
# retries when the first attempt fell just outside the server's tag
# radius due to interpolation lag.
const CONTACT_COOLDOWN_S := 0.15

var arena: Node = null

# Per-target last-attempt timestamps. Keyed by player id.
var _cooldowns: Dictionary = {}

func _init(arena_ref: Node) -> void:
	arena = arena_ref

## Drive one body-overlap pass. Called from arena._physics_process.
## Walks every non-local player and fires a tag or save (whichever is
## legal given current teams + frozen state) when inside CONTACT_RADIUS.
func check() -> void:
	var local: Node = arena.local_player
	if local == null:
		return
	var active: String = _active_team()
	var now: float = Time.get_unix_time_from_system()
	for id in arena.player_nodes.keys():
		if id == arena.local_player_id:
			continue
		var node: Node = arena.player_nodes[id]
		var dist: float = arena.topology.distance(local.global_position, node.global_position)
		if dist > CONTACT_RADIUS:
			continue
		if now - float(_cooldowns.get(id, 0.0)) < CONTACT_COOLDOWN_S:
			continue
		if _attempt(id, node, active, local):
			_cooldowns[id] = now

## Clear per-target cooldowns. Called from arena._on_snapshot (full state
## reset from server) and from reconnect_controller._schedule_next (before
## a reconnect attempt) so stale entries don't suppress the first contact
## after resume.
func reset_cooldowns() -> void:
	_cooldowns.clear()

func _attempt(id: String, node: Node, active: String, local: Node) -> bool:
	if active == local.team and node.team != local.team and not node.frozen:
		return _send_tag(id)
	if node.team == local.team and node.frozen:
		return _send_unfreeze(id)
	return false

func _active_team() -> String:
	if arena.online_mode:
		match arena.phase_label:
			"turn_mime": return "mime"
			"turn_clown": return "clown"
		return ""
	return arena.rules.active_team()

func _send_tag(target_id: String) -> bool:
	if arena.online_mode:
		# Same null / disconnected guard as _stream_input: the player can
		# trigger a tag during the one-frame window between _on_back_to_menu
		# (or a failed reconnect) nulling room_client and the scene actually
		# swapping.
		if arena.room_client == null or not arena.room_client.is_connected_to_server():
			return false
		arena.room_client.send_tag(target_id)
		return true
	return arena.rules.try_tag(arena.local_player_id, target_id)

func _send_unfreeze(target_id: String) -> bool:
	if arena.online_mode:
		if arena.room_client == null or not arena.room_client.is_connected_to_server():
			return false
		arena.room_client.send_unfreeze(target_id)
		return true
	return arena.rules.try_unfreeze(arena.local_player_id, target_id)
