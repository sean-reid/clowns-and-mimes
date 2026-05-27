extends Control

signal requested_screen(screen: String)

const AssetPaths := preload("res://scripts/asset_paths.gd")
const VersionCheck := preload("res://scripts/network/version_check.gd")

const SettingsPanel := preload("res://scenes/settings_panel.tscn")

@onready var host_button: Button = $Center/Buttons/HostButton
@onready var open_button: Button = $Center/Buttons/OpenButton
@onready var username_input: LineEdit = $Center/UsernameRow/Username
@onready var random_button: Button = $Center/UsernameRow/Random
@onready var topology_picker: OptionButton = $Center/TopologyRow/Topology
@onready var code_input: LineEdit = $Center/CodeRow/CodeEntry
@onready var join_button: Button = $Center/CodeRow/JoinButton
@onready var settings_button: Button = $SettingsButton

# Tracks whether the current username field value was typed by the player
# (vs produced by the Random button). Only typed names get persisted to
# Settings.custom_username on submit; random names are session-only.
var _username_was_typed: bool = false
# Set true while we programmatically rewrite username_input.text so the
# accompanying text_changed signal does NOT flip _username_was_typed back
# to true. Without this, Random + Host would save the random name.
var _suppress_username_signal: bool = false

func _ready() -> void:
	username_input.placeholder_text = "Optional username"
	random_button.pressed.connect(_randomize_name)
	host_button.pressed.connect(_host)
	join_button.pressed.connect(_join_code)
	code_input.text_changed.connect(_uppercase_code_field)
	# Enter/Return inside the code field submits, same as clicking Join.
	# Godot's LineEdit fires text_submitted when the user presses Enter while
	# the field has focus.
	code_input.text_submitted.connect(_on_code_submitted)
	open_button.pressed.connect(_join_open)
	settings_button.pressed.connect(_open_settings)
	username_input.text_changed.connect(_on_username_text_changed)
	_populate_topologies()
	# Restore a previously saved custom username if one exists. Loading it
	# back into GameState too means the lobby + arena pick it up without
	# any further wiring.
	if not Settings.custom_username.is_empty():
		GameState.username = Settings.custom_username
		_username_was_typed = true
	_suppress_username_signal = true
	username_input.text = GameState.username
	_suppress_username_signal = false
	# Idempotent: keeps the theme alive if the player returned here from a
	# match, and starts it if they somehow reached the menu without the title.
	# Unduck the Music bus in case a stinger left it lowered.
	AudioBus.set_bus_volume("Music", 0.0)
	AudioBus.play_music_from_path(AssetPaths.THEME_AUDIO)
	_check_for_updates()

func _check_for_updates() -> void:
	var checker := VersionCheck.new()
	add_child(checker)
	checker.update_available.connect(_show_update_popup)

	checker.check()

func _show_update_popup(local: String, latest: String) -> void:
	# Small modal popup with a single "Get latest" action that opens the
	# website (which already hydrates the download link from the same GitHub
	# release API the check uses). Stays out of the way if the player ignores
	# it - they can just press Esc / click the X and keep playing.
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

func _populate_topologies() -> void:
	topology_picker.clear()
	topology_picker.add_item("Plane", GameState.Topology.PLANE)
	topology_picker.add_item("Torus", GameState.Topology.TORUS)
	topology_picker.add_item("Möbius strip", GameState.Topology.MOBIUS)
	topology_picker.add_item("Klein bottle", GameState.Topology.KLEIN)

func _randomize_name() -> void:
	_suppress_username_signal = true
	username_input.text = UsernameGenerator.generate()
	_suppress_username_signal = false
	# Suppress catches the text_changed below; reset the typed flag here
	# so a subsequent submit treats this as a session-only random name.
	_username_was_typed = false

func _on_username_text_changed(_new_text: String) -> void:
	if _suppress_username_signal:
		return
	_username_was_typed = true

func _commit_username() -> void:
	var typed: String = username_input.text.strip_edges()
	if typed.is_empty():
		# Cleared field = explicit "use a random name." Drop any saved
		# custom so the next session also starts fresh instead of
		# resurrecting the old one.
		GameState.username = UsernameGenerator.generate()
		Settings.set_custom_username("")
		return
	GameState.username = typed
	# Only persist a name the player actually typed. Random names stay
	# session-only; we also don't clobber an existing saved custom when
	# the player just submitted without touching the field.
	if _username_was_typed:
		Settings.set_custom_username(typed)

func _host() -> void:
	_commit_username()
	GameState.set_mode(GameState.Mode.HOST)
	var idx := topology_picker.get_selected_id()
	GameState.set_topology(idx)
	requested_screen.emit("lobby")

func _uppercase_code_field(new_text: String) -> void:
	# Lobby codes are uppercase server-side; mirror that in the input so the
	# field never shows lowercase. Preserve the caret index across the rewrite
	# so the user can keep typing in the middle of the string.
	var upper := new_text.to_upper()
	if upper == new_text:
		return
	var caret := code_input.caret_column
	code_input.text = upper
	code_input.caret_column = caret

func _join_code() -> void:
	var code := code_input.text.strip_edges().to_upper()
	if code.length() < 4:
		code_input.grab_focus()
		return
	_commit_username()
	GameState.set_mode(GameState.Mode.JOIN)
	GameState.lobby_code = code
	requested_screen.emit("lobby")

func _on_code_submitted(_text: String) -> void:
	# LineEdit.text_submitted hands us the field's text, but _join_code reads
	# the input directly so the source of truth stays the same as clicking
	# Join. The arg is intentionally unused.
	_join_code()

func _join_open() -> void:
	_commit_username()
	GameState.set_mode(GameState.Mode.OPEN)
	requested_screen.emit("lobby")

func _open_settings() -> void:
	add_child(SettingsPanel.instantiate())
