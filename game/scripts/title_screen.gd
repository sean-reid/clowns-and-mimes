extends Control

## Three-phase animated title. Phases use distinct fonts and sizes.
## Phase 1: "CLOWNS AND MIMES"
## Phase 2: "ON MISCELLANEOUS TOPOLOGICAL SPACES"
## Phase 3: "... IN THE DARK!"

signal requested_screen(screen: String)

const AssetPaths := preload("res://scripts/asset_paths.gd")
const MatchmakerClient := preload("res://scripts/network/matchmaker_client.gd")

const PHASE_1_TEXT := "CLOWNS AND MIMES"
const PHASE_2_TEXT := "ON MISCELLANEOUS TOPOLOGICAL SPACES"
const PHASE_3_TEXT := "... IN THE DARK!"

@onready var line1: Label = $Lines/Line1
@onready var line2: Label = $Lines/Line2
@onready var line3: Label = $Lines/Line3
@onready var enter_button: Button = $EnterButton
@onready var background: ColorRect = $Background

func _ready() -> void:
	line1.text = ""
	line2.text = ""
	line3.text = ""
	enter_button.disabled = true
	enter_button.modulate.a = 0.0
	# A disabled Button still captures the mouse and emits mouse_entered, so the
	# wired hover SFX would fire while the button is still invisible. Ignore the
	# mouse entirely until the fade-in completes (restored in _animate).
	enter_button.mouse_filter = Control.MOUSE_FILTER_IGNORE
	background.modulate.a = 0.0
	enter_button.pressed.connect(_on_enter)
	AudioBus.wire_button_sfx(self)
	AudioBus.play_music_from_path(AssetPaths.THEME_AUDIO)
	# Probe matchmaker reachability now, while the title animates, so the menu's
	# online/offline state is already resolved when it opens - no flash of
	# disabled Open/Private buttons for an online player.
	_kick_connectivity_probe()
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
	t.tween_property(background, "modulate:a", 1.0, 0.6)
	# Snap the ENTER button in (like the title text) and make it live in the same
	# beat - no fade where it looks ready but silently rejects a click. The mouse
	# filter flips here too, so hover/click SFX start exactly when it's visible.
	t.tween_callback(func():
		enter_button.modulate.a = 1.0
		enter_button.disabled = false
		enter_button.mouse_filter = Control.MOUSE_FILTER_STOP
	)

# Fire-and-forget reachability probe. Stores the verdict on GameState so the menu
# reflects it immediately. If this is still in flight when the player reaches the
# menu, the menu falls back to its own probe (this one's client is freed with the
# title screen), so worst case is the old brief "checking" state.
func _kick_connectivity_probe() -> void:
	var probe := MatchmakerClient.new()
	add_child(probe)
	probe.health_result.connect(
		func(online: bool, reason: String) -> void:
			GameState.set_connectivity(
				GameState.Connectivity.ONLINE if online else GameState.Connectivity.OFFLINE, reason
			)
	)
	GameState.set_connectivity(GameState.Connectivity.CONNECTING)
	probe.probe_health()

func _on_enter() -> void:
	requested_screen.emit("menu")
