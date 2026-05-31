extends Node

## Canonical paths to optional binary assets. Code that wants to display a face
## texture or play a stinger should call `try_load_*` here so a missing file is
## handled the same way everywhere: returns null, no errors logged.

const MIME_TEXTURE := "res://assets/textures/mime_head.png"
const CLOWN_TEXTURE := "res://assets/textures/clown_head.png"

const THEME_AUDIO := "res://assets/audio/oompa_theme.mp3"
const LOSE_STINGER := "res://assets/audio/womp_womp.mp3"
const WIN_STINGER := "res://assets/audio/maniacal_laugh.mp3"
const FOOTSTEPS := "res://assets/audio/footsteps.mp3"
const UI_CLICK := "res://assets/audio/ui_click.wav"
const UI_HOVER := "res://assets/audio/ui_hover.wav"

static func try_load_texture(team: String) -> Texture2D:
	var path: String = MIME_TEXTURE if team == "mime" else CLOWN_TEXTURE
	return _safe_load(path) as Texture2D

static func try_load_audio(path: String) -> AudioStream:
	return _safe_load(path) as AudioStream

static func _safe_load(path: String) -> Resource:
	if not ResourceLoader.exists(path):
		return null
	return ResourceLoader.load(path)
