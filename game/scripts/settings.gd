extends Node

## Persistent player preferences (audio + graphics + profile). Backed by
## `user://settings.cfg` so the choices survive across launches.
##
## Audio:
##   - music_muted: silences the Music bus (title theme + lobby + match)
##   - sfx_muted: silences the SFX and UI buses (footsteps, tags, ambience, menu clicks)
##
## Graphics:
##   - light_mode: swaps the arena Environment + DirectionalLight to
##     bright daylight values. Applied per-scene by arena.gd at _ready
##     based on the current flag.
##
## Profile:
##   - custom_username: the last username the player typed by hand. Empty
##     string means "no saved name, generate a random one each session."
##     Names produced by the Random button are NOT saved here.
##
## Onboarding:
##   - has_seen_tutorial: set once the first-match hint sequence finishes or
##     is skipped. The arena shows the overlay only while this is false; the
##     "Replay tutorial" button in settings clears it to re-run.
##
## Mutations emit `changed` so the active scene can re-apply the visual
## side of the change immediately without reloading.

signal changed

const CONFIG_PATH := "user://settings.cfg"
const SECTION := "preferences"

var music_muted: bool = false
var sfx_muted: bool = false
var light_mode: bool = false
var custom_username: String = ""
# Falls back to the old vertical-stack menu when true. The carnival redesign
# (menu_v2) is the default; this escape hatch stays for a release or two in
# case the new layout misbehaves on a player's machine.
var use_v1_menu: bool = false
# Telemetry: tri-state. "" means the opt-in dialog hasn't run yet;
# "yes" / "no" are the player's choice once they've answered.
var telemetry_consent: String = ""
# Random UUID generated once and reused across sessions. No PII.
var telemetry_id: String = ""
# First-match onboarding overlay. False until the player finishes or skips it.
var has_seen_tutorial: bool = false

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

func set_custom_username(value: String) -> void:
	if custom_username == value:
		return
	custom_username = value
	_save()
	changed.emit()

func set_use_v1_menu(value: bool) -> void:
	if use_v1_menu == value:
		return
	use_v1_menu = value
	_save()
	changed.emit()

func set_telemetry_consent(value: String) -> void:
	if telemetry_consent == value:
		return
	telemetry_consent = value
	_save()
	changed.emit()

func set_has_seen_tutorial(value: bool) -> void:
	if has_seen_tutorial == value:
		return
	has_seen_tutorial = value
	_save()

func set_telemetry_id(value: String) -> void:
	if telemetry_id == value:
		return
	telemetry_id = value
	_save()

func _apply_audio() -> void:
	AudioBus.mute_bus("Music", music_muted)
	AudioBus.mute_bus("SFX", sfx_muted)
	# UI clicks/hovers count as sound effects, so the SFX toggle silences them too.
	AudioBus.mute_bus("UI", sfx_muted)

func _load() -> void:
	var cfg := ConfigFile.new()
	var err := cfg.load(CONFIG_PATH)
	if err != OK:
		# First boot, missing file, or corrupted - keep defaults.
		return
	music_muted = bool(cfg.get_value(SECTION, "music_muted", false))
	sfx_muted = bool(cfg.get_value(SECTION, "sfx_muted", false))
	light_mode = bool(cfg.get_value(SECTION, "light_mode", false))
	custom_username = String(cfg.get_value(SECTION, "custom_username", ""))
	use_v1_menu = bool(cfg.get_value(SECTION, "use_v1_menu", false))
	telemetry_consent = String(cfg.get_value(SECTION, "telemetry_consent", ""))
	telemetry_id = String(cfg.get_value(SECTION, "telemetry_id", ""))
	has_seen_tutorial = bool(cfg.get_value(SECTION, "has_seen_tutorial", false))

func _save() -> void:
	var cfg := ConfigFile.new()
	cfg.set_value(SECTION, "music_muted", music_muted)
	cfg.set_value(SECTION, "sfx_muted", sfx_muted)
	cfg.set_value(SECTION, "light_mode", light_mode)
	cfg.set_value(SECTION, "custom_username", custom_username)
	cfg.set_value(SECTION, "use_v1_menu", use_v1_menu)
	cfg.set_value(SECTION, "telemetry_consent", telemetry_consent)
	cfg.set_value(SECTION, "telemetry_id", telemetry_id)
	cfg.set_value(SECTION, "has_seen_tutorial", has_seen_tutorial)
	cfg.save(CONFIG_PATH)
