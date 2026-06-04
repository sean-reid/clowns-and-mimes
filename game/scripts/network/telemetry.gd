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

# distanceBucket cutoffs for projectile_hit, shared by the online + offline emit
# sites so the same shot buckets identically either way.
const HIT_BUCKET_CLOSE_MAX := 6.0
const HIT_BUCKET_MEDIUM_MAX := 16.0

var _buffer: Array[Dictionary] = []
var _flush_timer: Timer = null
var _client_version: String = ""
# Session bookkeeping for session_start / session_end.
var _session_start_ms: float = 0.0
var _session_emitted: bool = false
# Match timing + count: match_started stamps the clock, match_ended computes the
# duration and bumps the count that session_end reports.
var _match_start_ms: float = 0.0
var match_count: int = 0

func _ready() -> void:
	_client_version = ProjectSettings.get_setting("application/config/version", "0.0.0")
	_session_start_ms = float(Time.get_ticks_msec())
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

## --- typed event helpers (one per gameplay milestone) -------------------
## Each is a no-op until consent is granted (event() gates on is_enabled).

## Emit session_start once per run (guarded). Safe to call from the opt-in
## accept and from the menu _ready for an already-consented user.
func track_session_start() -> void:
	if _session_emitted or not is_enabled():
		return
	_session_emitted = true
	event({
		"t": "session_start",
		"v": _client_version,
		"platform": OS.get_name(),
		"telemetryId": Settings.telemetry_id,
	})

func track_match_start(topology: String, mode: String, party_size: int, bot_count: int) -> void:
	_match_start_ms = float(Time.get_ticks_msec())
	event({
		"t": "match_start",
		"topology": topology,
		"mode": mode,
		"partySize": party_size,
		"botCount": bot_count,
	})

func track_match_end(outcome: String, team: String) -> void:
	match_count += 1
	var duration_s: float = 0.0
	if _match_start_ms > 0.0:
		duration_s = (float(Time.get_ticks_msec()) - _match_start_ms) / 1000.0
	event({"t": "match_end", "durationS": duration_s, "outcome": outcome, "team": team})

func track_item_pickup(item_type: String) -> void:
	if item_type.is_empty():
		return
	event({"t": "item_pickup", "itemType": item_type})

func track_item_used(item_type: String) -> void:
	if item_type.is_empty():
		return
	event({"t": "item_used", "itemType": item_type})

func track_projectile_hit(distance: float) -> void:
	event({"t": "projectile_hit", "distanceBucket": distance_bucket(distance)})

## Map a shot's shooter-to-victim distance to the schema's bucket label.
static func distance_bucket(distance: float) -> String:
	if distance <= HIT_BUCKET_CLOSE_MAX:
		return "close"
	if distance <= HIT_BUCKET_MEDIUM_MAX:
		return "medium"
	return "far"

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
	# Emit session_end then flush on shutdown, so the session's duration + match
	# count get a (best-effort) chance to land before the process exits.
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_EXIT_TREE:
		if _session_emitted and is_enabled():
			var duration_s: float = (float(Time.get_ticks_msec()) - _session_start_ms) / 1000.0
			event({"t": "session_end", "durationS": duration_s, "matchCount": match_count})
		_flush()
