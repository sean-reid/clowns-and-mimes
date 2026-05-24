extends Control

## Three-phase animated title. Phases use distinct fonts and sizes.
## Phase 1: "CLOWNS AND MIMES"
## Phase 2: "ON MISCELLANEOUS TOPOLOGICAL SPACES"
## Phase 3: "... IN THE DARK!"

signal requested_screen(screen: String)

const AssetPaths := preload("res://scripts/asset_paths.gd")

const PHASE_1_TEXT := "CLOWNS AND MIMES"
const PHASE_2_TEXT := "ON MISCELLANEOUS TOPOLOGICAL SPACES"
const PHASE_3_TEXT := "... IN THE DARK!"

@onready var line1: Label = $Lines/Line1
@onready var line2: Label = $Lines/Line2
@onready var line3: Label = $Lines/Line3
@onready var enter_button: Button = $EnterButton
@onready var clown_panel: ColorRect = $Decor/ClownPanel
@onready var mime_panel: ColorRect = $Decor/MimePanel

func _ready() -> void:
	line1.text = ""
	line2.text = ""
	line3.text = ""
	enter_button.disabled = true
	enter_button.modulate.a = 0.0
	clown_panel.modulate.a = 0.0
	mime_panel.modulate.a = 0.0
	enter_button.pressed.connect(_on_enter)
	AudioBus.play_music_from_path(AssetPaths.THEME_AUDIO)
	_animate()

func _animate() -> void:
	var t := create_tween()
	t.set_parallel(false)
	t.tween_callback(func(): line1.text = PHASE_1_TEXT)
	t.tween_interval(1.4)
	t.tween_callback(func(): line2.text = PHASE_2_TEXT)
	t.tween_interval(1.4)
	t.tween_callback(func(): line3.text = PHASE_3_TEXT)
	t.tween_interval(0.7)
	t.tween_property(clown_panel, "modulate:a", 1.0, 0.6)
	t.parallel().tween_property(mime_panel, "modulate:a", 1.0, 0.6)
	t.tween_callback(func(): enter_button.disabled = false)
	t.tween_property(enter_button, "modulate:a", 1.0, 0.5)

func _on_enter() -> void:
	requested_screen.emit("menu")
