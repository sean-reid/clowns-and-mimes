extends Node

## Provides three logical buses: Music, SFX, UI. Bus configuration is bootstrapped
## here so the project boots without a pre-built default_bus_layout.tres.
##
## Also owns the long-lived music player so a stream started on the title screen
## keeps playing through menu, lobby, and arena swaps. Screens used to parent
## their AudioStreamPlayer to themselves and lost playback the moment the root
## scene called queue_free() on them.

const AssetPaths := preload("res://scripts/asset_paths.gd")

const BUSES := ["Music", "SFX", "UI"]

var _music_player: AudioStreamPlayer = null
var _current_music_path: String = ""

# Pre-allocated round-robin pool for one-shot UI clicks/hovers on the UI bus.
# Pooled (never add_child/free per event) so rapid menu interaction can't churn
# the scene tree. Streams are cached by path so we load each clip only once.
const UI_VOICES := 4
var _ui_players: Array[AudioStreamPlayer] = []
var _ui_next: int = 0
var _ui_streams: Dictionary = {}

func _ready() -> void:
	_ensure_buses()
	_ensure_music_player()
	_ensure_ui_players()

func _ensure_ui_players() -> void:
	if not _ui_players.is_empty():
		return
	for _i in range(UI_VOICES):
		var p := AudioStreamPlayer.new()
		p.bus = "UI"
		add_child(p)
		_ui_players.append(p)

func _ensure_buses() -> void:
	for name in BUSES:
		if AudioServer.get_bus_index(name) == -1:
			var idx := AudioServer.bus_count
			AudioServer.add_bus(idx)
			AudioServer.set_bus_name(idx, name)
			AudioServer.set_bus_send(idx, "Master")
			AudioServer.set_bus_volume_db(idx, 0.0)

func _ensure_music_player() -> void:
	if _music_player != null:
		return
	_music_player = AudioStreamPlayer.new()
	_music_player.bus = "Music"
	add_child(_music_player)

func play_music(stream: AudioStream, loop: bool = true) -> void:
	if stream == null:
		return
	_ensure_music_player()
	if stream is AudioStreamMP3:
		(stream as AudioStreamMP3).loop = loop
	elif stream is AudioStreamOggVorbis:
		(stream as AudioStreamOggVorbis).loop = loop
	if _music_player.stream == stream and _music_player.playing:
		return
	_music_player.stream = stream
	_music_player.play()

func play_music_from_path(path: String, loop: bool = true) -> void:
	# Idempotent: calling repeatedly with the same path while playback is
	# active is a no-op, so screens can call this in _ready without restarting
	# the track every navigation.
	if path == _current_music_path and _music_player != null and _music_player.playing:
		return
	if not ResourceLoader.exists(path):
		return
	var stream: AudioStream = ResourceLoader.load(path) as AudioStream
	if stream == null:
		return
	_current_music_path = path
	play_music(stream, loop)

func stop_music() -> void:
	if _music_player != null:
		_music_player.stop()
	_current_music_path = ""

func play_ui(path: String) -> void:
	# Fire-and-forget one-shot on the UI bus (menu clicks/hovers). Silently
	# no-ops when the clip is missing so a stripped build doesn't error.
	var stream: AudioStream = _ui_streams.get(path)
	if stream == null:
		if not ResourceLoader.exists(path):
			return
		stream = ResourceLoader.load(path) as AudioStream
		if stream == null:
			return
		_ui_streams[path] = stream
	var player := _ui_players[_ui_next]
	_ui_next = (_ui_next + 1) % _ui_players.size()
	player.stream = stream
	player.play()

## Recursively connect every Button under `root` to the UI click/hover SFX.
## Screens call this once in _ready so all their buttons sound the same without
## per-button wiring. Bound Callables compare equal, so re-wiring an already
## wired tree (e.g. a panel that re-enters _ready) is a no-op rather than a
## duplicate connection.
func wire_button_sfx(root: Node) -> void:
	for child in root.get_children():
		if child is BaseButton:
			var click := play_ui.bind(AssetPaths.UI_CLICK)
			var hover := play_ui.bind(AssetPaths.UI_HOVER)
			if not child.pressed.is_connected(click):
				child.pressed.connect(click)
			if not child.mouse_entered.is_connected(hover):
				child.mouse_entered.connect(hover)
		wire_button_sfx(child)

func set_bus_volume(bus_name: String, db: float) -> void:
	var idx := AudioServer.get_bus_index(bus_name)
	if idx >= 0:
		AudioServer.set_bus_volume_db(idx, db)

func mute_bus(bus_name: String, muted: bool) -> void:
	var idx := AudioServer.get_bus_index(bus_name)
	if idx >= 0:
		AudioServer.set_bus_mute(idx, muted)
