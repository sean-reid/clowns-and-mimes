extends Node

## Reconnect ladder + keepalive ping + connection-lost popup. Extracted
## from arena.gd under Phase C2 of the file-split plan.
##
## Node (not RefCounted) because it owns:
##   - a one-shot Timer for the banner-delay
##   - the banner Label parented under arena.hud
##   - the connection-lost AcceptDialog
##
## All require scene-tree membership. The controller is added as a
## child of arena in _ready and tears down with the arena scene.
##
## Host pattern: stores an `arena: Node` reference set at construction.
## Reads arena.room_client / arena.hud / arena.pending_inputs /
## arena.contact_cooldowns / arena.snapshot_received / arena._attach_dialog_lifecycle
## / arena._on_back_to_menu and writes to a couple of those.

# Keepalive ping interval. Cloudflare Durable Object sockets time out
# with a TLS fatal alert when idle long enough; periodic pings keep
# them warm.
const PING_INTERVAL_S := 5.0

# Backoff ladder for reconnect attempts after a WS drop. Most transient
# drops (DO migration, brief ISP wobble) resolve inside ~5 s of total
# ladder time, so the player never sees the hard "Reconnect / Quit"
# choice for those.
const RECONNECT_BACKOFF_S: Array[float] = [0.5, 1.5, 3.0]

# Delay before the "Reconnecting..." banner shows. Transient drops the
# ladder absorbs in under this don't flash the UI.
const RECONNECT_BANNER_DELAY_S := 1.0

var arena: Node = null

var _ping_accumulator: float = 0.0
var _reconnect_attempt: int = 0
var _reconnect_active: bool = false
var _reconnect_label: Label = null
var _reconnect_banner_timer: Timer = null
# Stashed so show_failed_popup can surface the original drop reason in
# the side log once the ladder has given up. Held back from the initial
# on_disconnected because the banner is the right transient UI; surfacing
# "Disconnected: closed by peer: -1" on every transient blip the ladder
# absorbs invisibly was noisy.
var _last_disconnect_reason: String = ""

func attach(arena_ref: Node) -> void:
	arena = arena_ref

func is_active() -> bool:
	return _reconnect_active

## Periodic keepalive ping. Called from arena._process while online.
func drive_keepalive(delta: float) -> void:
	if arena.room_client == null or not arena.room_client.is_connected_to_server():
		_ping_accumulator = 0.0
		return
	_ping_accumulator += delta
	if _ping_accumulator < PING_INTERVAL_S:
		return
	_ping_accumulator = 0.0
	arena.room_client.send_ping()

## Called from arena._on_room_connected. Clears reconnect state and
## hides the banner. Idempotent.
func handle_connected() -> void:
	_reconnect_attempt = 0
	_reconnect_active = false
	hide_banner()

## Called from arena._on_room_disconnected. Starts the reconnect
## ladder if one isn't already running.
func handle_disconnected(reason: String) -> void:
	if _reconnect_active:
		return
	_reconnect_active = true
	_reconnect_attempt = 0
	_last_disconnect_reason = reason
	show_banner_delayed("Reconnecting...")
	_schedule_next()

## Stop the ladder without going through the popup. Called when the
## player accepts the failed-popup "Back to menu" path.
func stop() -> void:
	_reconnect_active = false

func _schedule_next() -> void:
	if _reconnect_attempt >= RECONNECT_BACKOFF_S.size():
		show_failed_popup()
		return
	var wait_s: float = RECONNECT_BACKOFF_S[_reconnect_attempt]
	_reconnect_attempt += 1
	await get_tree().create_timer(wait_s).timeout
	if not _reconnect_active or arena.room_client == null:
		return
	# Clear stale per-session state so reconciliation does not replay inputs
	# from before the drop. The fresh snapshot from the server's onJoin will
	# repopulate everything. contact_cooldowns is keyed by player ID; ID reuse
	# across reconnects is unlikely but possible, and a stale entry would
	# silently swallow the first tag after resume.
	arena.pending_inputs.clear()
	arena.contact_cooldowns.clear()
	arena.snapshot_received = false
	arena.room_client.connect_to(GameState.server_url)
	# If the connect call dispatches another `disconnected` immediately
	# (handshake failure), arena._on_room_disconnected re-enters; otherwise
	# wait for `connected` to flip us out of the reconnect state. As a
	# backstop in case neither fires (socket stuck pending), schedule the
	# next ladder step after the same backoff window.
	await get_tree().create_timer(wait_s + 1.0).timeout
	if arena.room_client == null or not _reconnect_active:
		return
	if not arena.room_client.is_connected_to_server():
		_schedule_next()

func show_banner(text: String) -> void:
	if _reconnect_label == null:
		_reconnect_label = Label.new()
		_reconnect_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_reconnect_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		_reconnect_label.anchor_left = 0.0
		_reconnect_label.anchor_right = 1.0
		_reconnect_label.anchor_top = 0.45
		_reconnect_label.anchor_bottom = 0.55
		_reconnect_label.add_theme_font_size_override("font_size", 48)
		arena.hud.add_child(_reconnect_label)
	_reconnect_label.text = text
	_reconnect_label.visible = true

## Schedule the banner to appear after RECONNECT_BANNER_DELAY_S. If
## the reconnect succeeds inside that window hide_banner kills the
## timer and the banner never shows - no flicker for the common case
## of a brief CF edge blip.
func show_banner_delayed(text: String) -> void:
	_cancel_banner_timer()
	_reconnect_banner_timer = Timer.new()
	_reconnect_banner_timer.one_shot = true
	_reconnect_banner_timer.wait_time = RECONNECT_BANNER_DELAY_S
	add_child(_reconnect_banner_timer)
	_reconnect_banner_timer.timeout.connect(show_banner.bind(text))
	_reconnect_banner_timer.start()

func _cancel_banner_timer() -> void:
	if _reconnect_banner_timer != null:
		_reconnect_banner_timer.queue_free()
		_reconnect_banner_timer = null

func hide_banner() -> void:
	_cancel_banner_timer()
	if _reconnect_label != null:
		_reconnect_label.visible = false

func show_failed_popup() -> void:
	hide_banner()
	# Surface the last disconnect reason now that the ladder gave up.
	# Held back from handle_disconnected so the side log isn't spammed
	# with "Disconnected: closed by peer: -1" on every transient blip.
	if _last_disconnect_reason != "":
		arena.hud.append_log("Disconnected: %s" % _last_disconnect_reason)
	var dialog := AcceptDialog.new()
	dialog.title = "Connection lost"
	dialog.dialog_text = "Could not reach the server. Try again or back out to the main menu."
	dialog.ok_button_text = "Back to menu"
	dialog.unresizable = true
	var retry_button := dialog.add_button("Reconnect", true, "retry")
	retry_button.pressed.connect(_on_retry_pressed.bind(dialog))
	dialog.confirmed.connect(_on_give_up)
	arena._attach_dialog_lifecycle(dialog)
	dialog.popup_centered()

func _on_retry_pressed(dialog: AcceptDialog) -> void:
	dialog.queue_free()
	_reconnect_attempt = 0
	show_banner("Reconnecting...")
	_schedule_next()

func _on_give_up() -> void:
	_reconnect_active = false
	arena._on_back_to_menu()
