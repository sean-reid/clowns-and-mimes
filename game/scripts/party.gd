extends Control

## Pre-match party screen. A player creates a party (getting a shareable code)
## or joins one by code; friends who join land in the same open-matchmaking room
## and on the same team. "Find Match" hands off to the lobby in OPEN mode with
## the party id set, so each member's /open/join routes to the shared room. The
## screen polls the matchmaker so the roster tracks friends joining live.

signal requested_screen(screen: String)

const MatchmakerClientScript := preload("res://scripts/network/matchmaker_client.gd")

const POLL_INTERVAL := 2.0
const WAITING_NAME_TINT := Color(0.7, 0.7, 0.72)

@onready var status_label: Label = $Center/Status
@onready var entry: VBoxContainer = $Center/Entry
@onready var create_button: Button = $Center/Entry/CreateButton
@onready var code_entry: LineEdit = $Center/Entry/JoinRow/CodeEntry
@onready var join_button: Button = $Center/Entry/JoinRow/JoinButton
@onready var roster: VBoxContainer = $Center/Roster
@onready var code_label: Label = $Center/Roster/Code
@onready var copy_button: Button = $Center/Roster/CopyButton
@onready var members_box: VBoxContainer = $Center/Roster/Members
@onready var find_button: Button = $Center/Roster/Actions/FindButton
@onready var leave_button: Button = $Center/Roster/Actions/LeaveButton
@onready var back_button: Button = $BackButton

var matchmaker: Node = null
var _poll_timer: Timer = null
# Guards the auto-follow handoff so it fires exactly once when the party matches.
var _following: bool = false

func _ready() -> void:
	matchmaker = MatchmakerClientScript.new()
	add_child(matchmaker)
	matchmaker.party_ready.connect(_on_party_ready)
	matchmaker.party_refreshed.connect(_on_party_refreshed)
	matchmaker.party_join_failed.connect(_on_party_join_failed)
	matchmaker.party_gone.connect(_on_party_gone)
	matchmaker.request_failed.connect(_on_request_failed)
	create_button.pressed.connect(_on_create_pressed)
	join_button.pressed.connect(_on_join_pressed)
	code_entry.text_changed.connect(_uppercase_code)
	code_entry.text_submitted.connect(func(_t): _on_join_pressed())
	copy_button.pressed.connect(_on_copy_pressed)
	find_button.pressed.connect(_on_find_pressed)
	leave_button.pressed.connect(_on_leave_pressed)
	back_button.pressed.connect(_on_back_pressed)
	AudioBus.wire_button_sfx(self)
	_poll_timer = Timer.new()
	_poll_timer.wait_time = POLL_INTERVAL
	_poll_timer.timeout.connect(_poll)
	add_child(_poll_timer)
	_apply_intent()

# The menu decides create-vs-join, so honor that choice immediately instead of
# making the player pick again here. On an auto-handoff we hide the entry view
# up front so the create/join controls don't flash before the matchmaker
# responds - only the working status shows until the roster is ready. A failed
# auto-join falls back to the entry view so they can retype the code.
func _apply_intent() -> void:
	var intent := GameState.party_intent
	var code := GameState.party_join_code
	GameState.party_intent = ""
	GameState.party_join_code = ""
	if intent == "create":
		entry.visible = false
		roster.visible = false
		_on_create_pressed()
	elif intent == "join" and not code.is_empty():
		entry.visible = false
		roster.visible = false
		code_entry.text = code
		_on_join_pressed()
	elif not GameState.party_id.is_empty():
		# Returning from a match with the party intact: resume it so everyone can
		# Find Match again together, instead of dropping to the create/join entry.
		_resume_party()
	else:
		_show_entry()

# Re-enter the existing party (set in GameState before this screen loaded) after
# a match. Show the roster and start polling; the matchmaker cleared the party's
# old room on detach, so the poll reports no room and the party waits here until
# someone clicks Find Match again.
func _resume_party() -> void:
	entry.visible = false
	roster.visible = true
	code_label.text = "Party code: %s" % GameState.party_code
	status_label.text = "Back together. Find a match when everyone is ready."
	_poll_timer.start()
	_poll()

func _show_entry() -> void:
	entry.visible = true
	roster.visible = false
	status_label.text = "Create a party and share the code, or join a friend's."

func _on_create_pressed() -> void:
	create_button.disabled = true
	status_label.text = "Creating party..."
	matchmaker.create_party(GameState.username)

func _on_join_pressed() -> void:
	var code := code_entry.text.strip_edges().to_upper()
	if code.length() < 4:
		code_entry.grab_focus()
		return
	join_button.disabled = true
	status_label.text = "Joining party..."
	matchmaker.join_party(code, GameState.username)

func _on_party_ready(party_id: String, code: String, _team: String, member_id: String, members: Array) -> void:
	GameState.party_id = party_id
	GameState.party_member_id = member_id
	GameState.party_code = code
	entry.visible = false
	roster.visible = true
	code_label.text = "Party code: %s" % code
	status_label.text = "Share the code. Find a match when everyone is in."
	_render_members(members)
	_poll_timer.start()
	find_button.grab_focus()

func _on_party_refreshed(members: Array, room_id: String) -> void:
	_render_members(members)
	# Auto-follow into the match the moment any member has matched: whoever clicks
	# Find Match stamps the party's shared room, and everyone still on the party
	# screen rides along instead of each having to click it. Guarded so the
	# handoff fires once.
	if not room_id.is_empty() and not _following:
		_following = true
		_begin_find()

func _on_party_join_failed(reason: String) -> void:
	join_button.disabled = false
	# An auto-join hid the entry view; bring it back so they can retype the code.
	entry.visible = true
	roster.visible = false
	status_label.text = reason
	code_entry.grab_focus()

func _on_party_gone() -> void:
	_poll_timer.stop()
	_clear_party_state()
	status_label.text = "The party disbanded. Returning to menu."
	await get_tree().create_timer(1.5).timeout
	if is_inside_tree():
		requested_screen.emit("menu")

func _on_request_failed(reason: String) -> void:
	create_button.disabled = false
	join_button.disabled = false
	# An auto-handoff hid the entry view; bring it back so they can retry.
	entry.visible = true
	roster.visible = false
	status_label.text = reason

func _poll() -> void:
	if GameState.party_id.is_empty():
		return
	matchmaker.poll_party(GameState.party_id)

func _on_find_pressed() -> void:
	_following = true
	_begin_find()

# Hand off to the lobby in OPEN mode; it calls /open/join with the party id,
# routing this member to the shared room and team. Stop polling first so a late
# tick doesn't fire against a freed screen. Shared by the explicit Find Match
# button and the auto-follow when another member matches first.
func _begin_find() -> void:
	_poll_timer.stop()
	GameState.set_mode(GameState.Mode.OPEN)
	requested_screen.emit("lobby")

func _on_leave_pressed() -> void:
	_poll_timer.stop()
	if not GameState.party_id.is_empty():
		matchmaker.leave_party(GameState.party_id, GameState.party_member_id)
	_clear_party_state()
	# Drop back to the menu's join-by-code panel, not this scene's entry view.
	GameState.menu_panel = "joinparty"
	requested_screen.emit("menu")

func _on_back_pressed() -> void:
	_poll_timer.stop()
	if not GameState.party_id.is_empty():
		matchmaker.leave_party(GameState.party_id, GameState.party_member_id)
	_clear_party_state()
	requested_screen.emit("menu")

func _clear_party_state() -> void:
	GameState.party_id = ""
	GameState.party_member_id = ""
	GameState.party_size = 0
	GameState.party_code = ""

func _uppercase_code(new_text: String) -> void:
	var upper := new_text.to_upper()
	if upper == new_text:
		return
	var caret := code_entry.caret_column
	code_entry.text = upper
	code_entry.caret_column = caret

func _on_copy_pressed() -> void:
	var code := code_label.text.replace("Party code: ", "")
	if code.is_empty():
		return
	DisplayServer.clipboard_set(code)
	copy_button.text = "Copied!"
	await get_tree().create_timer(1.2).timeout
	if is_inside_tree() and is_instance_valid(copy_button):
		copy_button.text = "Copy code"

func _render_members(members: Array) -> void:
	# Mirror the roster size so the join (and the open room's gather-wait) knows
	# how many to expect from this party.
	GameState.party_size = members.size()
	for child in members_box.get_children():
		child.queue_free()
	if members.is_empty():
		var waiting := Label.new()
		waiting.text = "  waiting for players..."
		waiting.modulate = WAITING_NAME_TINT
		members_box.add_child(waiting)
		return
	for entry_dict in members:
		if not (entry_dict is Dictionary):
			continue
		var row := Label.new()
		var member_name := String(entry_dict.get("name", "?"))
		var is_me := String(entry_dict.get("memberId", "")) == GameState.party_member_id
		row.text = "- %s%s" % [member_name, " (you)" if is_me else ""]
		members_box.add_child(row)
