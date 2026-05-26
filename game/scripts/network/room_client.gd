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

func send_join(name: String, prefer_team: String = "") -> void:
	var payload := {"t": "join", "v": ServerConfig.protocol_version(), "name": name}
	if not prefer_team.is_empty():
		payload["preferTeam"] = prefer_team
	_enqueue(payload)

func send_input(seq: int, dt: float, move: Vector2, look_yaw: float, sprint: bool) -> void:
	_enqueue(
		{
			"t": "input",
			"input": {
				"seq": seq,
				"dt": dt,
				"move": {"x": move.x, "z": move.y},
				"lookYaw": look_yaw,
				"sprint": sprint,
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
			if err != OK:
				_send_queue.push_front(text)
				break
	elif state == WebSocketPeer.STATE_CLOSED and _connected:
		_connected = false
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
