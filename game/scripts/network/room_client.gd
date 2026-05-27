extends Node

## WebSocket client for the room Durable Object. Sends join, input, tag, and
## unfreeze messages. Emits parsed events for the arena to consume.

const ServerConfig := preload("res://scripts/network/server_config.gd")

signal connected
signal disconnected(reason: String)
signal snapshot_received(snapshot: Dictionary, you_are: String)
signal delta_received(delta: Dictionary)
signal event_received(event: Dictionary)
signal error_received(code: String, message: String)

var _socket: WebSocketPeer = null
var _connected: bool = false
var _send_queue: Array[String] = []
# Bound on the outbound queue. The arena enqueues inputs at 60 Hz and a
# ping every 5 s; if the underlying socket cannot drain (wifi dropped,
# tunnel wedged), the queue would otherwise grow unboundedly until the
# OS / TCP keepalive eventually marks the socket closed (~30 s+). Cap
# at one second of input cadence so memory stays bounded and the buffer
# never gets into a state where it cannot be sent in one tick after a
# reconnect.
const SEND_QUEUE_MAX := 64
# Per-connection resumption secret handed back by the server in the
# snapshot envelope. Sent on every subsequent send_join so a transient
# WS drop is treated as a reconnect (existing PlayerState resumed) rather
# than a fresh join (which would reject mid-match). Cleared on
# disconnect_from so leaving the game intentionally never lets a stale
# token claim a slot in a different room.
var session_token: String = ""

func connect_to(ws_url: String) -> void:
	# Drop any stale enqueued messages from a previous session before
	# starting a new one. Reconnecting after a disconnect would otherwise
	# replay old inputs with stale seq numbers as soon as the new socket
	# opens.
	_send_queue.clear()
	_socket = WebSocketPeer.new()
	_socket.handshake_headers = PackedStringArray()
	var err: int = _socket.connect_to_url(ws_url)
	if err != OK:
		disconnected.emit("connect failed: %d" % err)
		_socket = null

func disconnect_from() -> void:
	if _socket != null:
		_socket.close()
	_socket = null
	_connected = false
	_send_queue.clear()
	session_token = ""

func send_join(name: String, prefer_team: String = "", host_token: String = "") -> void:
	var payload := {"t": "join", "v": ServerConfig.protocol_version(), "name": name}
	if not prefer_team.is_empty():
		payload["preferTeam"] = prefer_team
	if not host_token.is_empty():
		payload["hostToken"] = host_token
	# session_token is only set after the server has handed us one in a
	# prior snapshot. Sending it here is what makes the next join a
	# reconnect rather than a fresh join.
	if not session_token.is_empty():
		payload["sessionToken"] = session_token
	_enqueue(payload)

# Host-only message that asks the room to leave the `filling` phase and
# transition into `free_roam`. The server rejects this from any client
# that did not present the matching hostToken on `join`.
func send_start_match() -> void:
	_enqueue({"t": "start_match"})

func send_input(
	seq: int,
	dt: float,
	move: Vector2,
	look_yaw: float,
	sprint: bool,
	jump: bool,
) -> void:
	_enqueue(
		{
			"t": "input",
			"input": {
				"seq": seq,
				"dt": dt,
				"move": {"x": move.x, "z": move.y},
				"lookYaw": look_yaw,
				"sprint": sprint,
				"jump": jump,
				# nowMs anchors the jumpStartedAt timestamp on the server so the
				# arc start matches the client's press time without an extra
				# round-trip. Server clamps to its own clock if the skew is
				# large; the value is otherwise unused for non-jump inputs.
				"nowMs": _now_ms(),
			},
		}
	)

func send_tag(target_id: String) -> void:
	_enqueue({"t": "tag_attempt", "targetId": target_id, "clientTime": _now_ms()})

func send_unfreeze(target_id: String) -> void:
	_enqueue({"t": "unfreeze_attempt", "targetId": target_id, "clientTime": _now_ms()})

func send_ping() -> void:
	_enqueue({"t": "ping", "clientTime": _now_ms()})

func _enqueue(payload: Dictionary) -> void:
	# Drop the oldest entry when the queue is at capacity. Inputs are
	# tick-bound and the server's seq-based ack lets reconciliation
	# recover from skipped packets, so the oldest queued frame is
	# always the least useful one to keep. Without this guard a wifi
	# drop would let the queue grow until process memory got tight,
	# and once the link came back the client would replay seconds of
	# stale input.
	if _send_queue.size() >= SEND_QUEUE_MAX:
		_send_queue.pop_front()
	_send_queue.append(JSON.stringify(payload))

func _process(_delta: float) -> void:
	if _socket == null:
		return
	_socket.poll()
	var state: int = _socket.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		if not _connected:
			_connected = true
			connected.emit()
		while _socket.get_available_packet_count() > 0:
			_handle_packet(_socket.get_packet())
		while not _send_queue.is_empty():
			var text: String = _send_queue.pop_front()
			var err: int = _socket.send_text(text)
			if err == OK:
				continue
			if err == ERR_OUT_OF_MEMORY:
				# wslay's outbound buffer is full. This happens when the
				# underlying transport cannot drain - typical of a yanked
				# wifi connection where the socket state still reports
				# OPEN but TCP retries are piling up. Without bailing
				# here the error would spam every process tick and the
				# reconnect ladder would not fire until the OS finally
				# closed the socket ~30 s later, by which time the
				# server's session-token grace window has expired and
				# the resume becomes a fresh join (= round restart).
				# Force the socket closed and emit disconnected so the
				# arena's ladder kicks in immediately.
				_socket.close()
				_connected = false
				_send_queue.clear()
				disconnected.emit("send buffer full (network gone?)")
				_socket = null
				return
			_send_queue.push_front(text)
			break
	elif state == WebSocketPeer.STATE_CLOSED and _connected:
		_connected = false
		_send_queue.clear()
		disconnected.emit("closed by peer: %d" % _socket.get_close_code())
		_socket = null

func _handle_packet(packet: PackedByteArray) -> void:
	var text: String = packet.get_string_from_utf8()
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	var data: Dictionary = parsed
	var kind: String = data.get("t", "")
	match kind:
		"snapshot":
			var snap: Dictionary = data.get("snapshot", {})
			var you_are: String = data.get("youAre", "")
			# Stash the resumption secret for the next reconnect, but only
			# from snapshots that carry one. Snapshots after a successful
			# resume re-issue the same token; missing field is treated as a
			# no-op so older server builds still work.
			var token: String = data.get("sessionToken", "")
			if not token.is_empty():
				session_token = token
			snapshot_received.emit(snap, you_are)
		"delta":
			delta_received.emit(data)
		"event":
			event_received.emit(data.get("kind", {}))
		"error":
			error_received.emit(data.get("code", ""), data.get("message", ""))
		_:
			# tag_result, unfreeze_result, pong, etc. are surfaced as raw events.
			event_received.emit(data)

func _now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0)

func is_connected_to_server() -> bool:
	return _connected
