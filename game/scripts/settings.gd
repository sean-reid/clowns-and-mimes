extends Node

## Persistent player preferences (audio + graphics). Backed by
## `user://settings.cfg` so the choices survive across launches.
##
## Audio:
##   - music_muted: silences the Music bus (title theme + lobby + match)
##   - sfx_muted: silences the SFX bus (footsteps, tags, ambience)
##
## Graphics:
##   - light_mode: swaps the arena Environment + DirectionalLight to
##     bright daylight values. Applied per-scene by arena.gd at _ready
##     based on the current flag.
##
## Mutations emit `changed` so the active scene can re-apply the visual
## side of the change immediately without reloading.

signal changed

const CONFIG_PATH := "user://settings.cfg"
const SECTION := "preferences"

var music_muted: bool = false
var sfx_muted: bool = false
var light_mode: bool = false

func _ready() -> void:
	_load()
	# Apply the audio side once on boot. Graphics need a live scene with
	# a WorldEnvironment to apply to, so that side is handled at the
	# scene level on _ready.
	_apply_audio()

func set_music_muted(value: bool) -> void:
	if music_muted == value:
		return
	music_muted = value
	_apply_audio()
	_save()
	changed.emit()

func set_sfx_muted(value: bool) -> void:
	if sfx_muted == value:
		return
	sfx_muted = value
	_apply_audio()
	_save()
	changed.emit()

func set_light_mode(value: bool) -> void:
	if light_mode == value:
		return
	light_mode = value
	_save()
	changed.emit()

func _apply_audio() -> void:
	AudioBus.mute_bus("Music", music_muted)
	AudioBus.mute_bus("SFX", sfx_muted)

func _load() -> void:
	var cfg := ConfigFile.new()
	var err := cfg.load(CONFIG_PATH)
	if err != OK:
		# First boot, missing file, or corrupted - keep defaults.
		return
	music_muted = bool(cfg.get_value(SECTION, "music_muted", false))
	sfx_muted = bool(cfg.get_value(SECTION, "sfx_muted", false))
	light_mode = bool(cfg.get_value(SECTION, "light_mode", false))

func _save() -> void:
	var cfg := ConfigFile.new()
	cfg.set_value(SECTION, "music_muted", music_muted)
	cfg.set_value(SECTION, "sfx_muted", sfx_muted)
	cfg.set_value(SECTION, "light_mode", light_mode)
	cfg.save(CONFIG_PATH)
