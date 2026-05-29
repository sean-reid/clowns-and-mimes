extends Control

## Pre-match lobby. Resolves matchmaker first, then opens the WebSocket
## through the NetClient autoload so the connection survives the eventual
## scene swap into the arena. While the lobby is on screen it renders the
## live player roster from snapshot / delta events and, for the host,
## offers a Start button that sends `start_match`. Non-host players see
## the roster and a "waiting for host" status.
##
## Phase change into anything other than `filling` is the cue to swap into
## the arena. The same RoomClient instance (parented under NetClient) is
## then re-used by the arena - no second join, no double-spawn.
##
## If the matchmaker call fails for any reason other than "code not
## found" (transient 5xx, offline), we fall back to offline-vs-bots like
## before. The lobby_not_found path routes the player back to the menu.

signal requested_screen(screen: String)

const MatchmakerClientScript := preload("res://scripts/network/matchmaker_client.gd")

const NETWORK_TIMEOUT := 4.0
# Subdued grey for the "Waiting..." placeholder name in the roster, so a
# yet-to-be-named slot reads as inactive vs. a real player line.
const WAITING_NAME_TINT := Color(0.7, 0.7, 0.72)

@onready var status_label: Label = $Center/Status
@onready var code_label: Label = $Center/Code
@onready var players_box: VBoxContainer = $Center/Players
@onready var back_button: Button = $BackButton
@onready var code_actions: HBoxContainer = $Center/CodeActions
@onready var copy_button: Button = $Center/CodeActions/CopyButton
@onready var start_button: Button = $Center/CodeActions/StartButton

var matchmaker: Node = null
var network_resolved: bool = false
# True once the lobby has handed control off to the arena (either because
# the room transitioned out of `filling` or because we fell back to
# offline). Used to ignore stray late signals.
var transition_started: bool = false
# RoomClient signals are wired here while the lobby is up. We unwire them
# during the transition so the arena's connections don't clash. The actual
# RoomClient lives under NetClient so it outlives this scene.
var _room_signal_handlers: Array = []

func _ready() -> void:
	back_button.pressed.connect(_on_back_pressed)
	copy_button.pressed.connect(_on_copy_pressed)
	start_button.pressed.connect(_on_start_pressed)
	_render()
	_start_matchmaking()

func _exit_tree() -> void:
	# Cover the case where the player exits the lobby without going through
	# the normal Back / Start transitions (e.g., scene swapped from
	# elsewhere). Stale signal handlers on a freed Lobby would crash the
	# RoomClient on the next packet.
	for entry in _room_signal_handlers:
		if entry[0] != null and entry[0].is_connected(entry[1], entry[2]):
			entry[0].disconnect(entry[1], entry[2])
	_room_signal_handlers.clear()

func _on_back_pressed() -> void:
	# Player abandoned the lobby. Tear down the WS so the server cleans up
	# their slot - leaving the RoomClient alive would have the next room
	# they joined inherit signals destined for the freed lobby.
	for entry in _room_signal_handlers:
		if entry[0] != null and entry[0].is_connected(entry[1], entry[2]):
			entry[0].disconnect(entry[1], entry[2])
	_room_signal_handlers.clear()
	NetClient.close()
	requested_screen.emit("menu")

func _render() -> void:
	match GameState.mode:
		GameState.Mode.HOST:
			status_label.text = (
				"Hosting on " + GameState.topology_as_string() + ". Waiting for friends to join."
			)
			code_label.text = "Code: %s" % _placeholder_code_if_missing()
		GameState.Mode.JOIN:
			status_label.text = "Joining lobby."
			code_label.text = "Code: %s" % GameState.lobby_code
		GameState.Mode.OPEN:
			status_label.text = "Searching for an open lobby."
			code_label.text = ""
		_:
			status_label.text = "Offline mode."
			code_label.text = ""

func _start_matchmaking() -> void:
	# Reset any stale host token from a previous session. Only the HOST
	# path repopulates it via _on_lobby_created; JOIN / OPEN modes never
	# carry a token, and a leftover value from a prior host session would
	# otherwise be sent on the next join and the server would falsely
	# accept that client as host.
	GameState.host_token = ""
	matchmaker = MatchmakerClientScript.new()
	add_child(matchmaker)
	matchmaker.lobby_created.connect(_on_lobby_created)
	matchmaker.lobby_joined.connect(_on_lobby_joined)
	matchmaker.lobby_not_found.connect(_on_lobby_not_found)
	matchmaker.request_failed.connect(_on_request_failed)
	_seed_player_list()
	match GameState.mode:
		GameState.Mode.HOST:
			matchmaker.create_private(GameState.topology_as_string())
		GameState.Mode.JOIN:
			matchmaker.join_code(GameState.lobby_code)
		GameState.Mode.OPEN:
			matchmaker.join_open()
		_:
			_go_offline("offline")
			return
	_schedule_fallback_timer()

func _schedule_fallback_timer() -> void:
	await get_tree().create_timer(NETWORK_TIMEOUT).timeout
	if not network_resolved:
		_go_offline("network timed out")

func _on_lobby_created(code: String, _room_id: String, ws_url: String, host_token: String) -> void:
	network_resolved = true
	GameState.lobby_code = code
	GameState.server_url = ws_url
	GameState.host_token = host_token
	code_label.text = "Code: %s" % code
	status_label.text = "Share the code. Start the match when everyone is ready."
	code_actions.visible = true
	start_button.grab_focus()
	_open_ws(GameState.username, host_token)

func _on_lobby_joined(_room_id: String, ws_url: String) -> void:
	network_resolved = true
	GameState.server_url = ws_url
	# OPEN matches have no host - the room auto-fills with bots / other
	# strangers and starts on its own once 2 humans or the bot-fill timer
	# fires. The status text needs to match what the player is actually
	# waiting on, otherwise OPEN players sit looking at a wrong "waiting
	# for the host to start" message.
	if GameState.mode == GameState.Mode.OPEN:
		status_label.text = "Finding more players..."
	else:
		status_label.text = "Connected. Waiting for the host to start."
	_open_ws(GameState.username, "")

func _on_request_failed(reason: String) -> void:
	_go_offline(reason)

func _on_lobby_not_found(code: String) -> void:
	# Don't fall back to offline mode for an invalid code. The player typed
	# something we can't honour - tell them, then bounce back to the menu.
	if network_resolved:
		return
	network_resolved = true
	GameState.server_url = ""
	GameState.lobby_code = ""
	status_label.text = 'Lobby "%s" not found. Returning to menu.' % code
	code_label.text = ""
	code_actions.visible = false
	await get_tree().create_timer(2.0).timeout
	if is_inside_tree():
		requested_screen.emit("menu")

func _go_offline(reason: String) -> void:
	if network_resolved:
		return
	network_resolved = true
	GameState.server_url = ""
	GameState.host_token = ""
	status_label.text = "Playing offline against bots. (%s)" % reason
	_finalize_and_transition()

func _open_ws(username: String, host_token: String) -> void:
	NetClient.open(GameState.server_url, username, host_token)
	# Wire RoomClient signals so we can render the roster and detect the
	# phase change into `free_roam`. Stored so we can disconnect on the
	# scene swap (the same RoomClient survives, but its consumers change).
	var rc: Node = NetClient.room_client
	if rc == null:
		# Open failed - should not happen but fall back gracefully.
		_go_offline("net client unavailable")
		return
	_room_signal_handlers = [
		[rc, "snapshot_received", _on_snapshot],
		[rc, "delta_received", _on_delta],
		[rc, "event_received", _on_event],
		[rc, "error_received", _on_room_error],
		[rc, "disconnected", _on_room_disconnected],
	]
	for entry in _room_signal_handlers:
		entry[0].connect(entry[1], entry[2])

func _on_snapshot(snapshot: Dictionary, _you_are: String) -> void:
	_render_roster_from(snapshot.get("players", []))
	var phase: String = snapshot.get("phase", "filling")
	# An initial snapshot arriving with a non-`filling` phase means the
	# room is already in a match (we connected late, or the server-side
	# matchmaker race) - the server has already rejected the join in that
	# case via error_received, but be defensive here too.
	if phase != "filling":
		_finalize_and_transition()

func _on_delta(delta: Dictionary) -> void:
	_render_roster_from(delta.get("players", []))
	# Phase comes through on delta too; transition the moment the room
	# leaves `filling`.
	var phase: String = delta.get("phase", "")
	if not phase.is_empty() and phase != "filling":
		_finalize_and_transition()

func _on_event(event: Dictionary) -> void:
	# Phase events arrive in the form { kind: 'phase', phase: '<name>' }.
	# We only care here about leaving `filling`; chase / freeze events are
	# the arena's business once it takes over.
	var kind: Variant = event.get("kind", "")
	if typeof(kind) == TYPE_DICTIONARY and kind.get("kind", "") == "phase":
		var phase: String = kind.get("phase", "")
		if not phase.is_empty() and phase != "filling":
			_finalize_and_transition()

func _on_room_error(code: String, message: String) -> void:
	if code == "match_in_progress":
		_show_match_in_progress_popup()
		return
	if code == "version_mismatch":
		_show_version_mismatch_popup(message)
		return
	status_label.text = "Server error: %s" % message

func _on_room_disconnected(reason: String) -> void:
	if transition_started:
		return
	status_label.text = "Disconnected from lobby. (%s)" % reason

func _show_match_in_progress_popup() -> void:
	var dialog := AcceptDialog.new()
	dialog.title = "Match in progress"
	dialog.dialog_text = "This match has already started. Wait for the next round and try again."
	dialog.ok_button_text = "Back to menu"
	dialog.unresizable = true
	dialog.confirmed.connect(func(): requested_screen.emit("menu"))
	add_child(dialog)
	dialog.popup_centered()

func _show_version_mismatch_popup(server_message: String) -> void:
	# Mirrors the popup the arena shows for the same close code, but routes
	# the player back to the menu instead of leaving them on the arena scene.
	var dialog := AcceptDialog.new()
	dialog.title = "Update required"
	dialog.dialog_text = (
		"This server needs a newer client.\n\n%s" % server_message
	)
	dialog.ok_button_text = "Back to menu"
	dialog.unresizable = true
	dialog.confirmed.connect(func(): requested_screen.emit("menu"))
	add_child(dialog)
	dialog.popup_centered()

func _on_start_pressed() -> void:
	if not NetClient.is_open():
		# Old offline-fallback path: host's Start before the WS is up just
		# transitions to the arena solo, like the previous build.
		_finalize_and_transition()
		return
	start_button.disabled = true
	status_label.text = "Starting match..."
	NetClient.send_start_match()
	# The server replies with a phase change event that flips us into the
	# arena via _on_event / _on_delta. If for any reason the server does
	# not respond, the lobby stays put and the player can press Back.

func _finalize_and_transition() -> void:
	if transition_started:
		return
	transition_started = true
	# Disconnect the lobby's signal handlers so the arena's own handlers
	# can take over without firing twice. The RoomClient itself stays
	# parented under NetClient. No artificial timer here - the server is
	# already ticking by the time we hit this point; every additional ms
	# the lobby holds the scene means a larger initial position jump for
	# remote players when the arena rehydrates from the cached snapshot.
	for entry in _room_signal_handlers:
		if entry[0] != null and entry[0].is_connected(entry[1], entry[2]):
			entry[0].disconnect(entry[1], entry[2])
	_room_signal_handlers.clear()
	requested_screen.emit("arena")

func _on_copy_pressed() -> void:
	if GameState.lobby_code.is_empty():
		return
	DisplayServer.clipboard_set(GameState.lobby_code)
	copy_button.text = "Copied!"
	await get_tree().create_timer(1.2).timeout
	if is_inside_tree() and is_instance_valid(copy_button):
		copy_button.text = "Copy code"

func _placeholder_code_if_missing() -> String:
	if not GameState.lobby_code.is_empty():
		return GameState.lobby_code
	return "------"

func _render_roster_from(entries: Array) -> void:
	for child in players_box.get_children():
		child.queue_free()
	var humans: Array = []
	for entry in entries:
		if entry is Dictionary and not bool(entry.get("bot", false)):
			humans.append(entry)
	if humans.is_empty():
		var waiting := Label.new()
		waiting.text = "  waiting for players..."
		waiting.modulate = WAITING_NAME_TINT
		players_box.add_child(waiting)
		return
	for entry in humans:
		var row := Label.new()
		row.text = "- " + String(entry.get("name", "?"))
		players_box.add_child(row)

func _seed_player_list() -> void:
	# Names are server-authored - both humans and bots. The lobby gets no
	# roster from the matchmaker call, so do NOT fabricate placeholder names
	# here; doing so would diverge from the real names the room snapshot
	# delivers a moment later when the arena loads. Show only the local
	# player plus a clearly-empty waiting state.
	for child in players_box.get_children():
		child.queue_free()
	var me := Label.new()
	me.text = "- " + GameState.username
	players_box.add_child(me)
	var waiting := Label.new()
	waiting.text = "  waiting for others..."
	waiting.modulate = WAITING_NAME_TINT
	players_box.add_child(waiting)
