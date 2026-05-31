extends Node

## Autoload that owns the WebSocket RoomClient across scene transitions.
## The lobby opens the connection (so the host's roster and Start button
## work pre-match); the arena re-uses the same connection so reconciliation
## and player state survive the scene swap.
##
## Lobby flow: `NetClient.open(ws_url, username, host_token)` instantiates a
## RoomClient as our child, connects, and sends `join`. The lobby UI hooks
## the RoomClient's signals to render the roster and wire its Start button
## to `send_start_match`. On the phase-change event into a turn / free-roam
## state, the lobby transitions to the arena and disconnects its handlers;
## the RoomClient itself stays parented under this autoload.
##
## Arena flow: reads `room_client` if non-null, hooks its own handlers, and
## skips its old `connect_to` + `send_join` path (those already ran in the
## lobby). When the player returns to the main menu, `close()` tears down
## the connection and frees the node.

const RoomClientScript := preload("res://scripts/network/room_client.gd")

var room_client: Node = null
# Cached most-recent snapshot. The lobby is usually the first consumer to
# see one - the arena attaches its own snapshot_received handler later but
# the server only emits a snapshot once per WS session. Stashing the
# snapshot here lets the arena rehydrate immediately on _start_online
# without waiting for a refresh that may never come.
var cached_snapshot: Dictionary = {}
var cached_you_are: String = ""

func open(ws_url: String, username: String, host_token: String) -> void:
	close()
	room_client = RoomClientScript.new()
	add_child(room_client)
	# The host token, if any, has to be on hand before connected fires,
	# since the join payload sends it. open() is the lobby's entry point so
	# we can rely on these being set together.
	room_client.connected.connect(func(): _on_connected(username, host_token), CONNECT_ONE_SHOT)
	# Cache the snapshot/youAre AND every delta that arrives so the arena
	# can rehydrate with current positions, not pre-match spawn coords.
	# Without delta caching the arena would replay the snapshot from join
	# time, then receive a delta with positions that have moved several
	# ticks - remote players would visibly jump on entry.
	room_client.snapshot_received.connect(_cache_snapshot)
	room_client.delta_received.connect(_cache_delta)
	room_client.connect_to(ws_url)

func _cache_snapshot(snapshot: Dictionary, you_are: String) -> void:
	cached_snapshot = snapshot
	cached_you_are = you_are

func _cache_delta(delta: Dictionary) -> void:
	# Overlay the delta's mutable fields onto the cached snapshot. The
	# room's `seed` and identity bits (youAre) only ship on the snapshot;
	# everything else (players, phase, turnEndsAt) ships on every delta.
	if cached_snapshot.is_empty():
		return
	if delta.has("players"):
		cached_snapshot["players"] = delta["players"]
	if delta.has("phase"):
		cached_snapshot["phase"] = delta["phase"]
	if delta.has("turnEndsAt"):
		cached_snapshot["turnEndsAt"] = delta["turnEndsAt"]

func _on_connected(username: String, host_token: String) -> void:
	if room_client == null:
		return
	# prefer_team is set only for an open-as-party join; the room honors it to
	# keep the party on one team. Empty for every other flow.
	room_client.send_join(username, GameState.prefer_team, host_token)

func send_start_match() -> void:
	if room_client == null:
		return
	room_client.send_start_match()

func send_restart_room() -> void:
	if room_client == null:
		return
	room_client.send_restart_room()

func close() -> void:
	cached_snapshot = {}
	cached_you_are = ""
	if room_client == null:
		return
	room_client.disconnect_from()
	room_client.queue_free()
	room_client = null

func is_open() -> bool:
	return room_client != null
