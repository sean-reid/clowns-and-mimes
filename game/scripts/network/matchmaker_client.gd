extends Node

## Talks to the matchmaker Worker over HTTP. Three operations: create a private
## lobby, join a private lobby by code, and join an open stranger lobby. Each
## resolves to a Dictionary with ws_url and room_id (or pushes an error signal).

const ServerConfig := preload("res://scripts/network/server_config.gd")

signal lobby_created(code: String, room_id: String, ws_url: String, host_token: String)
## `team` is the matchmaker-assigned team for an open-as-party join (so every
## member lands together); empty string for host / join-by-code / solo-open.
signal lobby_joined(room_id: String, ws_url: String, team: String)
## Emitted when the matchmaker returns 404 on a join-by-code request. The
## room never existed (or has expired); the lobby treats this as a hard
## error, not a "fall back to offline" trigger.
signal lobby_not_found(code: String)
signal request_failed(reason: String)
## Party create / join resolved: carries the party handle, shareable code,
## the team the whole party will land on, the caller's own member id, and the
## current roster (Array of { memberId, name }).
signal party_ready(party_id: String, code: String, team: String, member_id: String, members: Array)
## Live roster from a poll (GET /party/:id) so the screen tracks friends joining.
signal party_refreshed(members: Array)
## join_party failed with a reason the player can act on (bad code / party full).
signal party_join_failed(reason: String)
## A poll found the party gone (everyone left, or it aged out server-side).
signal party_gone()

func create_private(topology: String) -> void:
	_post("/lobby", {"topology": topology}, _on_create_response)

var _last_join_code: String = ""

func join_code(code: String) -> void:
	if code.length() < 4:
		request_failed.emit("Lobby code is too short.")
		return
	_last_join_code = code.to_upper()
	_post("/lobby/%s/join" % _last_join_code, {}, _on_join_response, _on_join_code_failure)

func join_open(party_id: String = "") -> void:
	var body: Dictionary = {"partyId": party_id} if not party_id.is_empty() else {}
	_post("/open/join", body, _on_join_response)

func create_party(name: String) -> void:
	_post("/party/create", {"name": name}, _on_party_response)

func join_party(code: String, name: String) -> void:
	_post("/party/%s/join" % code.to_upper(), {"name": name}, _on_party_response, _on_party_join_failure)

func leave_party(party_id: String, member_id: String) -> void:
	# Fire-and-forget: the player is already leaving the screen, so a failed
	# leave just lets the empty party age out server-side.
	_post("/party/%s/leave" % party_id, {"memberId": member_id})

func poll_party(party_id: String) -> void:
	_http_get("/party/%s" % party_id, _on_party_poll, _on_party_poll_failure)

func _post(
	path: String,
	body: Dictionary,
	on_response: Callable = Callable(),
	on_failure: Callable = Callable(),
) -> void:
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = 10.0
	http.request_completed.connect(_make_handler(http, on_response, on_failure))
	var url: String = ServerConfig.matchmaker_url() + path
	var payload: String = JSON.stringify(body) if body.size() > 0 else "{}"
	var err: int = http.request(url, _headers(), HTTPClient.METHOD_POST, payload)
	if err != OK:
		request_failed.emit("Could not reach the lobby server.")
		http.queue_free()

func _http_get(path: String, on_response: Callable, on_failure: Callable = Callable()) -> void:
	var http := HTTPRequest.new()
	add_child(http)
	http.timeout = 10.0
	http.request_completed.connect(_make_handler(http, on_response, on_failure))
	var url: String = ServerConfig.matchmaker_url() + path
	var err: int = http.request(url, _headers(), HTTPClient.METHOD_GET)
	if err != OK:
		request_failed.emit("Could not reach the lobby server.")
		http.queue_free()

func _headers() -> PackedStringArray:
	return [
		"Content-Type: application/json",
		"Accept: application/json",
		"X-Protocol-Version: %d" % ServerConfig.protocol_version(),
	]

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
		if on_response.is_valid():
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
	if http_status == 426 and error_code == "protocol_mismatch":
		return "This client is out of date. Update to play online."
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
	# hostToken is what the host's WS join payload sends so the room can
	# recognize them as host and gate the start_match message. The
	# matchmaker returns it only on POST /lobby (create); joinByCode for
	# other players never returns it.
	var host_token: String = parsed.get("hostToken", "")
	if code.is_empty() or room_id.is_empty() or ws_url.is_empty() or host_token.is_empty():
		request_failed.emit("Lobby server returned an incomplete response.")
		return
	lobby_created.emit(code, room_id, ws_url, host_token)

func _on_join_response(parsed: Dictionary) -> void:
	var room_id: String = parsed.get("roomId", "")
	var ws_url: String = parsed.get("wsUrl", "")
	if room_id.is_empty() or ws_url.is_empty():
		request_failed.emit("Lobby server returned an incomplete response.")
		return
	# `team` is present only on an open-as-party join; absent otherwise.
	lobby_joined.emit(room_id, ws_url, String(parsed.get("team", "")))

func _on_party_response(parsed: Dictionary) -> void:
	var party_id: String = parsed.get("partyId", "")
	var code: String = parsed.get("code", "")
	var team: String = parsed.get("team", "")
	var member_id: String = parsed.get("memberId", "")
	var members: Array = parsed.get("members", [])
	if party_id.is_empty() or code.is_empty() or member_id.is_empty():
		request_failed.emit("Lobby server returned an incomplete response.")
		return
	party_ready.emit(party_id, code, team, member_id, members)

func _on_party_poll(parsed: Dictionary) -> void:
	party_refreshed.emit(parsed.get("members", []))

# 404 here means the party is gone (disbanded / aged out): the screen routes
# the player back to the menu. Any other status is a transient poll blip - the
# poll fires every couple seconds, so swallow it rather than clobber the roster
# status label with a stale error the next poll would not clear.
func _on_party_poll_failure(http_status: int, _body: PackedByteArray) -> bool:
	if http_status == 404:
		party_gone.emit()
	return true

# Surface the matchmaker's specific rejection (404 unknown code, 409 full) so
# the player learns which it was rather than a generic failure.
func _on_party_join_failure(http_status: int, body: PackedByteArray) -> bool:
	if http_status == 404:
		party_join_failed.emit("No party found with that code.")
		return true
	if http_status == 409:
		party_join_failed.emit("That party is full.")
		return true
	return false
