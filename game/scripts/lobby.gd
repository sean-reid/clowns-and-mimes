extends Control

## Pre-match lobby. Attempts to talk to the matchmaker; if the network call
## fails or times out, transitions to the arena in offline mode so the player
## can still play against bots.

signal requested_screen(screen: String)

const MatchmakerClientScript := preload("res://scripts/network/matchmaker_client.gd")

const NETWORK_TIMEOUT := 4.0

@onready var status_label: Label = $Center/Status
@onready var code_label: Label = $Center/Code
@onready var players_box: VBoxContainer = $Center/Players
@onready var back_button: Button = $BackButton

var matchmaker: Node = null
var network_resolved: bool = false

func _ready() -> void:
	back_button.pressed.connect(func(): requested_screen.emit("menu"))
	_render()
	_start_matchmaking()

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
	matchmaker = MatchmakerClientScript.new()
	add_child(matchmaker)
	matchmaker.lobby_created.connect(_on_lobby_created)
	matchmaker.lobby_joined.connect(_on_lobby_joined)
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

func _on_lobby_created(code: String, _room_id: String, ws_url: String) -> void:
	network_resolved = true
	GameState.lobby_code = code
	GameState.server_url = ws_url
	code_label.text = "Code: %s" % code
	status_label.text = "Waiting for players..."
	_finalize_and_transition()

func _on_lobby_joined(_room_id: String, ws_url: String) -> void:
	network_resolved = true
	GameState.server_url = ws_url
	status_label.text = "Connected. Loading arena..."
	_finalize_and_transition()

func _on_request_failed(reason: String) -> void:
	_go_offline(reason)

func _go_offline(reason: String) -> void:
	if network_resolved:
		return
	network_resolved = true
	GameState.server_url = ""
	status_label.text = "Playing offline against bots. (%s)" % reason
	_finalize_and_transition()

func _finalize_and_transition() -> void:
	await get_tree().create_timer(0.7).timeout
	requested_screen.emit("arena")

func _placeholder_code_if_missing() -> String:
	if not GameState.lobby_code.is_empty():
		return GameState.lobby_code
	return "------"

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
	waiting.text = "  waiting for opponents..."
	waiting.modulate = Color(0.7, 0.7, 0.72)
	players_box.add_child(waiting)
