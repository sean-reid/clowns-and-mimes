extends CanvasLayer

## Modal settings overlay. Reads the current Settings autoload state on
## open, mirrors toggle changes back through Settings.set_* (which both
## persists and applies the audio side immediately), and pauses the
## game tree while visible so the player can adjust things mid-match
## without input bleeding through.

signal closed

@onready var mute_music: CheckButton = $Content/MuteMusic
@onready var mute_sfx: CheckButton = $Content/MuteSfx
@onready var light_mode: CheckButton = $Content/LightMode
@onready var close_button: Button = $Content/Close

func _ready() -> void:
	# Pause-aware so it works on top of an in-game pause overlay too.
	process_mode = Node.PROCESS_MODE_ALWAYS
	_refresh_from_settings()
	mute_music.toggled.connect(Settings.set_music_muted)
	mute_sfx.toggled.connect(Settings.set_sfx_muted)
	light_mode.toggled.connect(_on_light_mode_toggled)
	close_button.pressed.connect(_on_close)

func _refresh_from_settings() -> void:
	mute_music.button_pressed = Settings.music_muted
	mute_sfx.button_pressed = Settings.sfx_muted
	light_mode.button_pressed = Settings.light_mode

func _on_light_mode_toggled(value: bool) -> void:
	Settings.set_light_mode(value)
	# Apply immediately if there's an arena live below us. Visual change
	# is too startling if it waits for the next scene load.
	var arena := get_tree().get_first_node_in_group("arena")
	if arena and arena.has_method("apply_light_mode"):
		arena.apply_light_mode(value)

func _on_close() -> void:
	closed.emit()
	queue_free()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		_on_close()
		get_viewport().set_input_as_handled()
