extends Control

## Carnival main menu. Collapses the old vertical button stack into two primary
## actions — "Find Match" (open queue) and "Play with Friends" (a flyout that
## folds in Host / Join-by-code / Party) — with the username promoted to an
## edit-in-place line at the top and Settings tucked into a corner gear.
## The old layout still ships behind Settings.use_v1_menu.

signal requested_screen(screen: String)

const AssetPaths := preload("res://scripts/asset_paths.gd")
const VersionCheck := preload("res://scripts/network/version_check.gd")
const SettingsPanel := preload("res://scenes/settings_panel.tscn")

# Picker id past the four concrete topologies = "Random" (rolled client-side).
const RANDOM_TOPOLOGY_ID := 100

@onready var user_label: Label = $TopBar/UserRow/UserLabel
@onready var edit_link: Button = $TopBar/UserRow/EditLink
@onready var edit_row: HBoxContainer = $TopBar/EditRow
@onready var username_input: LineEdit = $TopBar/EditRow/Username
@onready var random_button: Button = $TopBar/EditRow/Random
@onready var save_button: Button = $TopBar/EditRow/Save
@onready var find_match_button: Button = $Center/Primary/FindMatchButton
@onready var friends_button: Button = $Center/Primary/FriendsButton
@onready var flyout: PanelContainer = $Center/Flyout
@onready var topology_picker: OptionButton = $Center/Flyout/FlyoutBox/TopologyRow/Topology
@onready var host_button: Button = $Center/Flyout/FlyoutBox/HostButton
@onready var code_input: LineEdit = $Center/Flyout/FlyoutBox/CodeRow/CodeEntry
@onready var join_button: Button = $Center/Flyout/FlyoutBox/CodeRow/JoinButton
@onready var party_button: Button = $Center/Flyout/FlyoutBox/PartyButton
@onready var settings_button: Button = $SettingsButton
@onready var confetti: CPUParticles2D = $Confetti

# See main_menu.gd: only typed names persist; Random names are session-only.
var _username_was_typed: bool = false
var _suppress_username_signal: bool = false

func _ready() -> void:
	find_match_button.pressed.connect(_find_match)
	friends_button.pressed.connect(_toggle_flyout)
	host_button.pressed.connect(_host)
	join_button.pressed.connect(_join_code)
	party_button.pressed.connect(_open_party)
	settings_button.pressed.connect(_open_settings)
	edit_link.pressed.connect(_begin_edit)
	save_button.pressed.connect(_commit_edit)
	random_button.pressed.connect(_randomize_name)
	code_input.text_changed.connect(_uppercase_code_field)
	code_input.text_submitted.connect(func(_t): _join_code())
	username_input.text_changed.connect(_on_username_text_changed)
	username_input.text_submitted.connect(func(_t): _commit_edit())
	_wire_button_sfx()
	_populate_topologies()
	flyout.visible = false
	edit_row.visible = false
	if not Settings.custom_username.is_empty():
		GameState.username = Settings.custom_username
		_username_was_typed = true
	if GameState.username.is_empty():
		GameState.username = UsernameGenerator.generate()
	_refresh_user_label()
	# Idempotent: keep the theme alive across navigation, unduck Music in case a
	# stinger left it lowered.
	AudioBus.set_bus_volume("Music", 0.0)
	AudioBus.play_music_from_path(AssetPaths.THEME_AUDIO)
	_check_for_updates()
	_maybe_show_telemetry_opt_in()

func _wire_button_sfx() -> void:
	for button in [
		find_match_button, friends_button, host_button, join_button,
		party_button, settings_button, edit_link, random_button, save_button,
	]:
		button.pressed.connect(func(): AudioBus.play_ui(AssetPaths.UI_CLICK))
		button.mouse_entered.connect(func(): AudioBus.play_ui(AssetPaths.UI_HOVER))

func _populate_topologies() -> void:
	topology_picker.clear()
	topology_picker.add_item("Plane", GameState.Topology.PLANE)
	topology_picker.add_item("Torus", GameState.Topology.TORUS)
	topology_picker.add_item("Möbius strip", GameState.Topology.MOBIUS)
	topology_picker.add_item("Klein bottle", GameState.Topology.KLEIN)
	topology_picker.add_item("Random", RANDOM_TOPOLOGY_ID)

func _refresh_user_label() -> void:
	user_label.text = "Playing as %s" % GameState.username

# --- username edit-in-place ------------------------------------------------

func _begin_edit() -> void:
	_suppress_username_signal = true
	username_input.text = GameState.username
	_suppress_username_signal = false
	edit_row.visible = true
	user_label.visible = false
	edit_link.visible = false
	username_input.grab_focus()
	username_input.select_all()

func _commit_edit() -> void:
	var typed: String = username_input.text.strip_edges()
	if typed.is_empty():
		# Cleared = "use a random name"; drop any saved custom too.
		GameState.username = UsernameGenerator.generate()
		Settings.set_custom_username("")
	else:
		GameState.username = typed
		if _username_was_typed:
			Settings.set_custom_username(typed)
	edit_row.visible = false
	user_label.visible = true
	edit_link.visible = true
	_refresh_user_label()

func _randomize_name() -> void:
	_suppress_username_signal = true
	username_input.text = UsernameGenerator.generate()
	_suppress_username_signal = false
	_username_was_typed = false

func _on_username_text_changed(_new_text: String) -> void:
	if _suppress_username_signal:
		return
	_username_was_typed = true

# --- primary actions -------------------------------------------------------

func _find_match() -> void:
	flyout.visible = false
	_burst_confetti()
	# Solo open-join: drop any stale party handle so /open/join doesn't route us
	# into a party room we already left.
	GameState.party_id = ""
	GameState.party_member_id = ""
	GameState.host_random_topology = false
	GameState.set_mode(GameState.Mode.OPEN)
	requested_screen.emit("lobby")

func _toggle_flyout() -> void:
	flyout.visible = not flyout.visible

func _host() -> void:
	_burst_confetti()
	var idx := topology_picker.get_selected_id()
	GameState.host_random_topology = idx == RANDOM_TOPOLOGY_ID
	if GameState.host_random_topology:
		GameState.roll_random_topology()
	else:
		GameState.set_topology(idx)
	GameState.set_mode(GameState.Mode.HOST)
	requested_screen.emit("lobby")

func _join_code() -> void:
	var code := code_input.text.strip_edges().to_upper()
	if code.length() < 4:
		code_input.grab_focus()
		return
	GameState.host_random_topology = false
	GameState.set_mode(GameState.Mode.JOIN)
	GameState.lobby_code = code
	requested_screen.emit("lobby")

func _uppercase_code_field(new_text: String) -> void:
	var upper := new_text.to_upper()
	if upper == new_text:
		return
	var caret := code_input.caret_column
	code_input.text = upper
	code_input.caret_column = caret

func _open_party() -> void:
	requested_screen.emit("party")

func _open_settings() -> void:
	add_child(SettingsPanel.instantiate())

func _burst_confetti() -> void:
	if confetti == null:
		return
	confetti.restart()
	confetti.emitting = true

# --- update check + telemetry opt-in (parity with the v1 menu) -------------

func _check_for_updates() -> void:
	var checker := VersionCheck.new()
	add_child(checker)
	checker.update_available.connect(_show_update_popup)
	checker.check()

func _show_update_popup(local: String, latest: String) -> void:
	var dialog := AcceptDialog.new()
	dialog.title = "Update available"
	dialog.dialog_text = (
		"A newer version is available.\n\nYou have v%s.  Latest is v%s."
		% [local, latest]
	)
	dialog.ok_button_text = "Close"
	dialog.unresizable = true
	var open_button := dialog.add_button("Get latest", true, "open_site")
	open_button.pressed.connect(func(): OS.shell_open(VersionCheck.WEBSITE_URL))
	add_child(dialog)
	dialog.popup_centered()

func _maybe_show_telemetry_opt_in() -> void:
	if not Settings.telemetry_consent.is_empty():
		return
	var dialog := ConfirmationDialog.new()
	dialog.title = "Share gameplay stats?"
	dialog.dialog_text = (
		"Help improve Clowns and Mimes by sharing anonymous gameplay "
		+ "stats (match duration, items used, no personal info)?"
	)
	dialog.ok_button_text = "Yes, share"
	dialog.get_cancel_button().text = "No thanks"
	dialog.unresizable = true
	dialog.confirmed.connect(_accept_telemetry)
	dialog.canceled.connect(func(): Settings.set_telemetry_consent("no"))
	dialog.confirmed.connect(dialog.queue_free)
	dialog.canceled.connect(dialog.queue_free)
	dialog.close_requested.connect(dialog.queue_free)
	add_child(dialog)
	dialog.popup_centered()

func _accept_telemetry() -> void:
	Settings.set_telemetry_consent("yes")
	Telemetry.ensure_id()
	Telemetry.event({
		"t": "session_start",
		"v": ProjectSettings.get_setting("application/config/version", "0.0.0"),
		"platform": OS.get_name(),
		"telemetryId": Settings.telemetry_id,
	})
