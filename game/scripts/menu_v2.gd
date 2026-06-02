extends Control

## Carnival main menu built as a small panel navigator. The click tree is:
##   Open Match   -> Party up with friends -> Create party / Join party
##                -> Play solo
##   Private Match -> Host match (pick topology) / Join match (enter code)
## Leaf actions hand off to the lobby (solo / host / join) or the party screen
## (create / join), which own the matchmaker calls, code display, and start.
## The mascots, title, and background stay scene-level so every panel keeps the
## same carnival frame. The old flat menu still ships behind Settings.use_v1_menu.

signal requested_screen(screen: String)

const AssetPaths := preload("res://scripts/asset_paths.gd")
const VersionCheck := preload("res://scripts/network/version_check.gd")
const MatchmakerClient := preload("res://scripts/network/matchmaker_client.gd")
const SettingsPanel := preload("res://scenes/settings_panel.tscn")
# Popups are Window-based, so they don't inherit this scene's theme - assign it
# explicitly to keep the dialogs on the carnival font/button styling.
const CARNIVAL_THEME := preload("res://assets/themes/carnival_theme.tres")

# Picker id past the four concrete topologies = "Random" (rolled client-side).
const RANDOM_TOPOLOGY_ID := 100

# How often the menu silently re-probes the matchmaker so a reconnect flips the
# UI back to online (and a drop flips it to offline) without the player acting.
const CONNECTIVITY_REPROBE_S := 10.0

# Panels that only make sense online; if we go offline while one is open, snap
# back to root so the player isn't stuck on a dead-end flow.
const ONLINE_PANELS := ["open", "private", "party", "host", "joinmatch", "joinparty"]

@onready var user_label: Label = $TopBar/UserRow/UserLabel
@onready var edit_link: Button = $TopBar/UserRow/EditLink
@onready var edit_row: HBoxContainer = $TopBar/EditRow
@onready var username_input: LineEdit = $TopBar/EditRow/Username
@onready var random_button: Button = $TopBar/EditRow/Random
@onready var save_button: Button = $TopBar/EditRow/Save
@onready var settings_button: Button = $SettingsButton
@onready var confetti: CPUParticles2D = $Confetti
@onready var topology_picker: OptionButton = $Panels/HostPanel/TopologyRow/Topology
@onready var offline_topology_picker: OptionButton = $Panels/OfflinePanel/TopologyRow/Topology
@onready var match_code: LineEdit = $Panels/JoinMatchPanel/CodeEntry
@onready var party_code: LineEdit = $Panels/JoinPartyPanel/CodeEntry
@onready var open_button: Button = $Panels/RootPanel/OpenButton
@onready var private_button: Button = $Panels/RootPanel/PrivateButton
@onready var connectivity_bar: VBoxContainer = $ConnectivityBar
@onready var connectivity_status: Label = $ConnectivityBar/Status
@onready var retry_button: Button = $ConnectivityBar/Retry

# Panel name -> the panel above it, for Back. Root has no parent.
const BACK_TARGET := {
	"open": "root",
	"private": "root",
	"party": "open",
	"host": "private",
	"joinmatch": "private",
	"joinparty": "party",
	"offline": "root",
}

var _panels: Dictionary = {}
var _username_was_typed: bool = false
var _suppress_username_signal: bool = false
# Matchmaker reachability probe + the timer that re-runs it.
var _client: Node = null
var _probe_in_flight: bool = false

func _ready() -> void:
	_panels = {
		"root": $Panels/RootPanel,
		"open": $Panels/OpenPanel,
		"private": $Panels/PrivatePanel,
		"party": $Panels/PartyPanel,
		"host": $Panels/HostPanel,
		"joinmatch": $Panels/JoinMatchPanel,
		"joinparty": $Panels/JoinPartyPanel,
		"offline": $Panels/OfflinePanel,
	}
	# Root navigation.
	$Panels/RootPanel/OpenButton.pressed.connect(func(): _show_panel("open"))
	$Panels/RootPanel/PrivateButton.pressed.connect(func(): _show_panel("private"))
	$Panels/RootPanel/OfflineButton.pressed.connect(func(): _show_panel("offline"))
	# Open match.
	$Panels/OpenPanel/PartyButton.pressed.connect(func(): _show_panel("party"))
	$Panels/OpenPanel/SoloButton.pressed.connect(_play_solo)
	# Private match.
	$Panels/PrivatePanel/HostButton.pressed.connect(func(): _show_panel("host"))
	$Panels/PrivatePanel/JoinButton.pressed.connect(func(): _show_panel("joinmatch"))
	# Party.
	$Panels/PartyPanel/CreateButton.pressed.connect(_create_party)
	$Panels/PartyPanel/JoinButton.pressed.connect(func(): _show_panel("joinparty"))
	# Host / join leaves.
	$Panels/HostPanel/StartButton.pressed.connect(_host)
	$Panels/JoinMatchPanel/JoinButton.pressed.connect(_join_match)
	$Panels/JoinPartyPanel/JoinButton.pressed.connect(_join_party)
	# Offline leaf + reconnect retry.
	$Panels/OfflinePanel/StartButton.pressed.connect(_play_offline)
	retry_button.pressed.connect(_probe_connectivity)
	# Back buttons (named "Back" under each panel that has a parent).
	for panel_name in BACK_TARGET:
		var back: Button = _panels[panel_name].get_node("Back")
		var target: String = BACK_TARGET[panel_name]
		back.pressed.connect(func(): _show_panel(target))
	# Code fields uppercase + submit-to-join.
	match_code.text_changed.connect(func(t): _uppercase(match_code, t))
	match_code.text_submitted.connect(func(_t): _join_match())
	party_code.text_changed.connect(func(t): _uppercase(party_code, t))
	party_code.text_submitted.connect(func(_t): _join_party())
	# Username edit-in-place + settings.
	edit_link.pressed.connect(_begin_edit)
	save_button.pressed.connect(_commit_edit)
	random_button.pressed.connect(_randomize_name)
	settings_button.pressed.connect(_open_settings)
	username_input.text_changed.connect(_on_username_text_changed)
	username_input.text_submitted.connect(func(_t): _commit_edit())

	_populate_topologies()
	AudioBus.wire_button_sfx(self)
	# A screen can hand us back to a specific panel (e.g. leaving a party returns
	# to "joinparty"); fall back to root when unset or unknown.
	var open_panel := GameState.menu_panel
	GameState.menu_panel = ""
	_show_panel(open_panel if _panels.has(open_panel) else "root")
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
	_setup_connectivity()

func _show_panel(panel_name: String) -> void:
	for key in _panels:
		_panels[key].visible = key == panel_name


func _populate_topologies() -> void:
	# Host (online) and offline both pick a shape, so fill both the same way.
	_fill_topology_picker(topology_picker)
	_fill_topology_picker(offline_topology_picker)

func _fill_topology_picker(picker: OptionButton) -> void:
	picker.clear()
	picker.add_item("Plane", GameState.Topology.PLANE)
	picker.add_item("Torus", GameState.Topology.TORUS)
	picker.add_item("Möbius strip", GameState.Topology.MOBIUS)
	picker.add_item("Klein bottle", GameState.Topology.KLEIN)
	picker.add_item("Random", RANDOM_TOPOLOGY_ID)

# --- connectivity probe ----------------------------------------------------

# Build the matchmaker client + re-probe timer, then fire the first probe. The
# UI starts in CONNECTING (online actions disabled) and resolves to ONLINE or
# OFFLINE; a background timer keeps it current so reconnects need no action.
func _setup_connectivity() -> void:
	_client = MatchmakerClient.new()
	add_child(_client)
	_client.health_result.connect(_on_health_result)
	GameState.connectivity_changed.connect(_on_connectivity_changed)
	var timer := Timer.new()
	timer.wait_time = CONNECTIVITY_REPROBE_S
	timer.autostart = true
	timer.timeout.connect(_reprobe)
	add_child(timer)
	_refresh_connectivity_ui()
	# The title screen kicks off the first probe, so its result is usually already
	# on GameState by now - reflect it without a forced CONNECTING flash. Only
	# probe here if it hasn't resolved yet (title probe still in flight / orphaned).
	var resolved: bool = (
		GameState.connectivity == GameState.Connectivity.ONLINE
		or GameState.connectivity == GameState.Connectivity.OFFLINE
	)
	if not resolved:
		_probe_connectivity()

# Explicit probe (first load + Retry): announce CONNECTING so the UI reflects it.
func _probe_connectivity() -> void:
	if _probe_in_flight:
		return
	_probe_in_flight = true
	GameState.set_connectivity(GameState.Connectivity.CONNECTING)
	_client.probe_health()

# Background probe: don't flash CONNECTING, just refresh the verdict on result.
func _reprobe() -> void:
	if _probe_in_flight:
		return
	_probe_in_flight = true
	_client.probe_health()

func _on_health_result(online: bool, reason: String) -> void:
	_probe_in_flight = false
	GameState.set_connectivity(
		GameState.Connectivity.ONLINE if online else GameState.Connectivity.OFFLINE,
		reason,
	)

func _on_connectivity_changed(_state: int, _reason: String) -> void:
	_refresh_connectivity_ui()

# Online actions are gated on a reachable matchmaker; offline play is always
# available. Reflect the current state in the root buttons + the status banner.
func _refresh_connectivity_ui() -> void:
	var state: int = GameState.connectivity
	var online := state == GameState.Connectivity.ONLINE
	open_button.disabled = not online
	private_button.disabled = not online
	match state:
		GameState.Connectivity.CONNECTING:
			connectivity_bar.visible = true
			connectivity_status.text = "Checking for a connection…"
			retry_button.visible = false
		GameState.Connectivity.OFFLINE:
			connectivity_bar.visible = true
			connectivity_status.text = "You're offline — only offline play against bots is available."
			retry_button.visible = true
			_route_off_online_panels()
		_:
			connectivity_bar.visible = false

# If we drop offline while sitting on an online-only panel, return to root so
# the player lands on the still-usable offline button instead of a dead flow.
func _route_off_online_panels() -> void:
	for panel_name in ONLINE_PANELS:
		if _panels[panel_name].visible:
			_show_panel("root")
			return

# --- leaf actions ----------------------------------------------------------

func _play_solo() -> void:
	_burst_confetti()
	# Drop any stale party handle so /open/join doesn't route us into a party
	# room we already left.
	GameState.party_id = ""
	GameState.party_member_id = ""
	GameState.party_intent = ""
	GameState.host_random_topology = false
	GameState.set_mode(GameState.Mode.OPEN)
	requested_screen.emit("lobby")

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

# Explicit offline play vs bots with a chosen (or random) topology. Skips the
# matchmaker entirely: empty server_url + Mode.OFFLINE routes the lobby straight
# to the offline arena.
func _play_offline() -> void:
	_burst_confetti()
	GameState.party_id = ""
	GameState.party_member_id = ""
	GameState.party_intent = ""
	var idx := offline_topology_picker.get_selected_id()
	GameState.host_random_topology = idx == RANDOM_TOPOLOGY_ID
	if GameState.host_random_topology:
		GameState.roll_random_topology()
	else:
		GameState.set_topology(idx)
	GameState.server_url = ""
	GameState.set_mode(GameState.Mode.OFFLINE)
	requested_screen.emit("lobby")

func _join_match() -> void:
	var code := match_code.text.strip_edges().to_upper()
	if code.length() < 4:
		match_code.grab_focus()
		return
	GameState.host_random_topology = false
	GameState.set_mode(GameState.Mode.JOIN)
	GameState.lobby_code = code
	requested_screen.emit("lobby")

func _create_party() -> void:
	_burst_confetti()
	GameState.party_id = ""
	GameState.party_member_id = ""
	GameState.party_intent = "create"
	requested_screen.emit("party")

func _join_party() -> void:
	var code := party_code.text.strip_edges().to_upper()
	if code.length() < 4:
		party_code.grab_focus()
		return
	GameState.party_id = ""
	GameState.party_member_id = ""
	GameState.party_intent = "join"
	GameState.party_join_code = code
	requested_screen.emit("party")

func _uppercase(field: LineEdit, new_text: String) -> void:
	var upper := new_text.to_upper()
	if upper == new_text:
		return
	var caret := field.caret_column
	field.text = upper
	field.caret_column = caret

# --- username edit-in-place ------------------------------------------------

func _refresh_user_label() -> void:
	user_label.text = "Playing as %s" % GameState.username

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
	dialog.theme = CARNIVAL_THEME
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
	dialog.theme = CARNIVAL_THEME
	dialog.title = "Share gameplay stats?"
	dialog.dialog_text = (
		"Help improve Clowns and Mimes by sharing anonymous gameplay "
		+ "stats (match duration, items used, no personal info)?"
	)
	dialog.ok_button_text = "Yes, share"
	dialog.get_cancel_button().text = "No thanks"
	dialog.unresizable = true
	# Cap the label width so the prompt wraps instead of stretching wide.
	var label := dialog.get_label()
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.custom_minimum_size = Vector2(360, 0)
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
