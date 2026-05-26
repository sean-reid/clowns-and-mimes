extends Control

signal requested_screen(screen: String)

const AssetPaths := preload("res://scripts/asset_paths.gd")
const VersionCheck := preload("res://scripts/network/version_check.gd")

@onready var host_button: Button = $Center/Buttons/HostButton
@onready var open_button: Button = $Center/Buttons/OpenButton
@onready var username_input: LineEdit = $Center/UsernameRow/Username
@onready var random_button: Button = $Center/UsernameRow/Random
@onready var topology_picker: OptionButton = $Center/TopologyRow/Topology
@onready var code_input: LineEdit = $Center/CodeRow/CodeEntry
@onready var join_button: Button = $Center/CodeRow/JoinButton

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
	_populate_topologies()
	username_input.text = GameState.username
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
	username_input.text = UsernameGenerator.generate()

func _commit_username() -> void:
	if username_input.text.is_empty():
		GameState.username = UsernameGenerator.generate()
	else:
		GameState.username = username_input.text.strip_edges()

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
