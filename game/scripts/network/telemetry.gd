extends Node

## Opt-in telemetry client. Buffers events locally, flushes to the
## telemetry Worker on a timer or on app shutdown. No PII; identifier
## is a random UUID stored in Settings.
##
## Disabled until the user opts in via the menu's first-launch dialog.
## A no-op until then; safe to call event() from any code path.

const DEFAULT_TELEMETRY := "https://cm-telemetry.seanreid.workers.dev"
const ENV_VAR := "CLOWNS_TELEMETRY_URL"
const FLUSH_INTERVAL_S := 30.0
const MAX_BUFFER := 50

var _buffer: Array[Dictionary] = []
var _flush_timer: Timer = null
var _client_version: String = ""

func _ready() -> void:
	_client_version = ProjectSettings.get_setting("application/config/version", "0.0.0")
	_flush_timer = Timer.new()
	_flush_timer.wait_time = FLUSH_INTERVAL_S
	_flush_timer.autostart = true
	_flush_timer.timeout.connect(_flush)
	add_child(_flush_timer)

func is_enabled() -> bool:
	return Settings.telemetry_consent == "yes"

## Record an event. No-op when consent isn't granted. Caller passes a
## dict with a "t" key naming the event type plus payload fields. See
## backend/shared/src/telemetry.ts for the canonical schema.
func event(payload: Dictionary) -> void:
	if not is_enabled():
		return
	if not payload.has("t"):
		return
	_buffer.append(payload)
	if _buffer.size() >= MAX_BUFFER:
		_flush()

func _flush() -> void:
	if not is_enabled() or _buffer.is_empty():
		return
	var batch: Array = _buffer.duplicate()
	_buffer.clear()
	var body := {
		"events": batch,
		"telemetryId": Settings.telemetry_id,
		"clientVersion": _client_version,
	}
	var http := HTTPRequest.new()
	add_child(http)
	http.request_completed.connect(func(_r, _c, _h, _b): http.queue_free())
	var url: String = _base_url() + "/events"
	var headers: PackedStringArray = ["Content-Type: application/json"]
	var err: int = http.request(url, headers, HTTPClient.METHOD_POST, JSON.stringify(body))
	if err != OK:
		# Best-effort. Drop the batch on transport failure rather than
		# spinning forever; we're measurement, not delivery-guaranteed.
		http.queue_free()

## Ensure a telemetry_id is set. Called after the user accepts the opt-in.
func ensure_id() -> void:
	if Settings.telemetry_id.is_empty():
		Settings.set_telemetry_id(_random_uuid())

# RFC 4122 v4 UUID generator. Godot 4 has no built-in uuid; this is
# 16 random bytes + the version/variant nibbles set per spec.
func _random_uuid() -> String:
	var b: PackedByteArray = []
	b.resize(16)
	for i in 16:
		b[i] = randi() & 0xFF
	b[6] = (b[6] & 0x0F) | 0x40
	b[8] = (b[8] & 0x3F) | 0x80
	return "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x" % [
		b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
		b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15],
	]

func _base_url() -> String:
	var from_env := OS.get_environment(ENV_VAR)
	if not from_env.is_empty():
		return from_env
	return DEFAULT_TELEMETRY

func _notification(what: int) -> void:
	# Flush on shutdown so the session_end event at least gets a chance.
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_EXIT_TREE:
		_flush()
