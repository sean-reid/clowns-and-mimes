extends Node

## Talks to the matchmaker Worker over HTTP. Three operations: create a private
## lobby, join a private lobby by code, and join an open stranger lobby. Each
## resolves to a Dictionary with ws_url and room_id (or pushes an error signal).

const ServerConfig := preload("res://scripts/network/server_config.gd")

signal lobby_created(code: String, room_id: String, ws_url: String)
signal lobby_joined(room_id: String, ws_url: String)
## Emitted when the matchmaker returns 404 on a join-by-code request. The
## room never existed (or has expired); the lobby treats this as a hard
## error, not a "fall back to offline" trigger.
signal lobby_not_found(code: String)
signal request_failed(reason: String)

func create_private(topology: String) -> void:
	_post("/lobby", {"topology": topology}, _on_create_response)

var _last_join_code: String = ""

func join_code(code: String) -> void:
	if code.length() < 4:
		request_failed.emit("Lobby code is too short.")
		return
	_last_join_code = code.to_upper()
	_post("/lobby/%s/join" % _last_join_code, {}, _on_join_response, _on_join_code_failure)

func join_open() -> void:
	_post("/open/join", {}, _on_join_response)

func _post(
	path: String,
	body: Dictionary,
	on_response: Callable,
	on_failure: Callable = Callable(),
) -> void:
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = 10.0
	http.request_completed.connect(_make_handler(http, on_response, on_failure))
	var url: String = ServerConfig.matchmaker_url() + path
	var headers: PackedStringArray = ["Content-Type: application/json", "Accept: application/json"]
	var payload: String = JSON.stringify(body) if body.size() > 0 else "{}"
	var err: int = http.request(url, headers, HTTPClient.METHOD_POST, payload)
	if err != OK:
		request_failed.emit("Could not reach the lobby server.")
		http.queue_free()

func _make_handler(http: HTTPRequest, on_response: Callable, on_failure: Callable) -> Callable:
	return func(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
		http.queue_free()
		if code < 200 or code >= 300:
			if on_failure.is_valid() and on_failure.call(code, body):
				return
			request_failed.emit(_friendly_http_error(code, body))
			return
		var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
		if typeof(parsed) != TYPE_DICTIONARY:
			request_failed.emit("Unexpected response from the server.")
			return
		on_response.call(parsed)

# Map an HTTP status (and the optional `{ "error": "<code>" }` body the
# matchmaker Worker sends) to a sentence the player can read. Falls through
# to a generic message for unrecognized statuses so a new failure mode
# never shows as a blank string.
func _friendly_http_error(http_status: int, body: PackedByteArray) -> String:
	var error_code := _extract_error_code(body)
	if http_status == 400 and error_code == "invalid_topology":
		return "That topology is not available."
	if http_status == 400 and error_code == "invalid_json":
		return "Bad request to the server."
	if http_status == 400:
		return "The server rejected the request."
	if http_status == 404:
		return "Lobby not found."
	if http_status == 429:
		return "Too many requests. Wait a moment and try again."
	if http_status >= 500:
		return "Server unavailable. Try again."
	return "Could not reach the lobby server (%d)." % http_status

func _extract_error_code(body: PackedByteArray) -> String:
	if body.is_empty():
		return ""
	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY:
		return ""
	return parsed.get("error", "")

# Returns true when the failure has been handled by a specific signal,
# suppressing the generic request_failed emission.
func _on_join_code_failure(http_status: int, _body: PackedByteArray) -> bool:
	if http_status == 404:
		lobby_not_found.emit(_last_join_code)
		return true
	return false

func _on_create_response(parsed: Dictionary) -> void:
	var code: String = parsed.get("code", "")
	var room_id: String = parsed.get("roomId", "")
	var ws_url: String = parsed.get("wsUrl", "")
	if code.is_empty() or room_id.is_empty() or ws_url.is_empty():
		request_failed.emit("Lobby server returned an incomplete response.")
		return
	lobby_created.emit(code, room_id, ws_url)

func _on_join_response(parsed: Dictionary) -> void:
	var room_id: String = parsed.get("roomId", "")
	var ws_url: String = parsed.get("wsUrl", "")
	if room_id.is_empty() or ws_url.is_empty():
		request_failed.emit("Lobby server returned an incomplete response.")
		return
	lobby_joined.emit(room_id, ws_url)
