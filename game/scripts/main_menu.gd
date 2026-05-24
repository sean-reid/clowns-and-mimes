extends Control

signal requested_screen(screen: String)

const AssetPaths := preload("res://scripts/asset_paths.gd")

@onready var host_button: Button = $Center/Buttons/HostButton
@onready var code_button: Button = $Center/Buttons/CodeButton
@onready var open_button: Button = $Center/Buttons/OpenButton
@onready var username_input: LineEdit = $Center/UsernameRow/Username
@onready var random_button: Button = $Center/UsernameRow/Random
@onready var topology_picker: OptionButton = $Center/TopologyRow/Topology
@onready var code_input: LineEdit = $Center/CodeRow/CodeEntry

func _ready() -> void:
	username_input.placeholder_text = "Optional username"
	random_button.pressed.connect(_randomize_name)
	host_button.pressed.connect(_host)
	code_button.pressed.connect(_join_code)
	open_button.pressed.connect(_join_open)
	_populate_topologies()
	username_input.text = GameState.username
	# Idempotent: keeps the theme alive if the player returned here from a
	# match, and starts it if they somehow reached the menu without the title.
	# Unduck the Music bus in case a stinger left it lowered.
	AudioBus.set_bus_volume("Music", 0.0)
	AudioBus.play_music_from_path(AssetPaths.THEME_AUDIO)

func _populate_topologies() -> void:
	topology_picker.clear()
	topology_picker.add_item("Plane", GameState.Topology.PLANE)
	topology_picker.add_item("Torus", GameState.Topology.TORUS)
	topology_picker.add_item("Klein bottle", GameState.Topology.KLEIN)
	topology_picker.add_item("Sphere", GameState.Topology.SPHERE)

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

func _join_code() -> void:
	var code := code_input.text.strip_edges().to_upper()
	if code.length() < 4:
		code_input.grab_focus()
		return
	_commit_username()
	GameState.set_mode(GameState.Mode.JOIN)
	GameState.lobby_code = code
	requested_screen.emit("lobby")

func _join_open() -> void:
	_commit_username()
	GameState.set_mode(GameState.Mode.OPEN)
	requested_screen.emit("lobby")
