extends Node

## Provides three logical buses: Music, SFX, UI. Bus configuration is bootstrapped
## here so the project boots without a pre-built default_bus_layout.tres.
##
## Also owns the long-lived music player so a stream started on the title screen
## keeps playing through menu, lobby, and arena swaps. Screens used to parent
## their AudioStreamPlayer to themselves and lost playback the moment the root
## scene called queue_free() on them.

const BUSES := ["Music", "SFX", "UI"]

var _music_player: AudioStreamPlayer = null
var _current_music_path: String = ""

func _ready() -> void:
	_ensure_buses()
	_ensure_music_player()

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

func set_bus_volume(bus_name: String, db: float) -> void:
	var idx := AudioServer.get_bus_index(bus_name)
	if idx >= 0:
		AudioServer.set_bus_volume_db(idx, db)

func mute_bus(bus_name: String, muted: bool) -> void:
	var idx := AudioServer.get_bus_index(bus_name)
	if idx >= 0:
		AudioServer.set_bus_mute(idx, muted)
