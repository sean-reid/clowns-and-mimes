extends Node3D

## Game arena.
##
## Two modes:
##   - Offline: a local GameRules engine owns phase progression, tag/unfreeze
##     validation, and win detection. Bots play against the local player.
##   - Online: a RoomClient streams inputs to the room Durable Object and
##     applies authoritative snapshots and deltas. The local rules engine is
##     not used.
##
## Online mode is selected when GameState.server_url is non-empty after the
## lobby has resolved the matchmaker call. Both paths share player spawning,
## the in-game menu, contact-based interaction detection, and the HUD.

signal requested_screen(screen: String)

# ---------------------------------------------------------------------------
# Preloads
# ---------------------------------------------------------------------------

const PLAYER := preload("res://scenes/player.tscn")
const LABYRINTH := preload("res://scenes/labyrinth.tscn")
const Movement := preload("res://scripts/movement.gd")
const IN_GAME_MENU := preload("res://scenes/in_game_menu.tscn")
const GameRulesScript := preload("res://scripts/game_rules.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")
const BotAIScript := preload("res://scripts/bot_ai.gd")
const AssetPaths := preload("res://scripts/asset_paths.gd")
const RoomClientScript := preload("res://scripts/network/room_client.gd")

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

const BOT_COUNT_PER_TEAM := 3
const SPAWN_RADIUS := 2.5
const CONTACT_RADIUS := 1.4
# Short cooldown only to keep one physics frame from firing the same tag
# repeatedly. The server already de-dupes via its own cooldown / frozen state
# checks, so we don't need a long client-side gate that would suppress
# legitimate retries when the first attempt fell just outside the server's
# tag radius due to interpolation lag.
const CONTACT_COOLDOWN_S := 0.15
## Client input cadence. Matches the server's TICK_HZ in
## backend/room/src/room.ts so each server tick consumes exactly one input
## (one stepMovement call) on average. Going lower would queue inputs on the
## server and lag reconciliation; going higher would skip inputs because the
## server only applies the most recent input per tick.
const INPUT_TICK_HZ := 60.0
const INPUT_TICK_PERIOD := 1.0 / INPUT_TICK_HZ

# Send a ping every PING_INTERVAL_S so the WebSocket has accidental-keepalive
# traffic even when the player is idle. Cloudflare Durable Object sockets get
# torn down with a TLS fatal alert (mbedtls -0x7780) when they sit idle long
# enough; periodic pings keep the connection warm.
const PING_INTERVAL_S := 5.0

# When the server-side WS dies, try to reconnect with a short cumulative
# backoff before showing the player a hard "Reconnect / Quit" choice. Most
# transient drops (DO migration, brief ISP wobble) resolve inside ~5 s, so
# the player never sees the menu bounce for those.
const RECONNECT_BACKOFF_S: Array[float] = [0.5, 1.5, 3.0]

const MIME_BATTLE_CRIES := [
	"MIMES- ATTACK!", "MIMES- STRIKE!", "MIMES- POUNCE!", "MIMES- ENTRAP!",
	"MIMES- BAFFLE!", "MIMES- SHUSH!", "MIMES- GLARE!", "MIMES- LUNGE!",
]

const CLOWN_BATTLE_CRIES := [
	"CLOWNS- ATTACK!", "CLOWNS- STRIKE!", "CLOWNS- HONK!", "CLOWNS- BOOP!",
	"CLOWNS- CACKLE!", "CLOWNS- CHARGE!", "CLOWNS- ROMP!", "CLOWNS- POUNCE!",
]

# ---------------------------------------------------------------------------
# Scene refs and state
# ---------------------------------------------------------------------------

@onready var world: Node3D = $World
@onready var spawn: Marker3D = $World/Spawn
@onready var labyrinth_holder: Node3D = $World/LabyrinthHolder
@onready var hud: CanvasLayer = $HUD

var topology: TopologyScript
var labyrinth: Node3D = null
var menu: CanvasLayer = null

# Offline-only.
var rules: Node = null

# Online-only.
var room_client: Node = null
var online_mode: bool = false
var snapshot_received: bool = false
var phase_label: String = ""
var turn_ends_at_ms: int = 0
var input_seq: int = 0
var input_accumulator: float = 0.0
# Pending inputs since the last server ack. Each entry is
#   {"seq": int, "world_move": Vector2, "sprint": bool, "dt": float}
# world_move is already rotated into world XZ coords so replay does not need
# to know the yaw at the original tick.
var pending_inputs: Array = []
var local_sprint_energy: float = 100.0
# Mirrors PlayerState.sprinting on the server. Tracks whether the predictor
# is currently in the "sprint engaged" half of the hysteresis. Server
# broadcasts the authoritative value in each delta; reconciliation seeds the
# replay loop from it.
var local_sprinting: bool = false

# Tick-bound prediction with render-rate visual interpolation. The authoritative
# predicted XZ advances once per physics tick inside _advance_predicted_tick,
# matching what the server applies. _process interpolates the rendered body
# transform between the previous and current tick positions so a >60 Hz monitor
# still gets smooth motion. Reconciliation rewrites _pred_current_xz to the
# replayed authoritative value and re-anchors _pred_prev_xz to where the body
# is rendered right now, which spreads the correction over the next tick instead
# of producing a visible snap.
var _pred_prev_xz: Vector2 = Vector2.ZERO
var _pred_current_xz: Vector2 = Vector2.ZERO
var _pred_tick_start_t: float = 0.0
var _pred_armed: bool = false

# Shared.
var local_player: Node = null
var local_player_id: String = ""
var player_nodes: Dictionary = {}
var contact_cooldowns: Dictionary = {}

# WS keepalive + reconnect state.
var _ping_accumulator: float = 0.0
var _reconnect_attempt: int = 0
var _reconnect_active: bool = false
var _reconnect_label: Label = null

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

func _ready() -> void:
	online_mode = not GameState.server_url.is_empty()
	_setup_menu()
	hud.set_sprint(100.0)
	# Leave the countdown label blank until the first phase update arrives;
	# seeding "10" was a leftover from the removed pre-match countdown phase
	# and flashed 10 -> 0 on every round start before the free-roam timer
	# took over.
	hud.set_countdown_seconds(-1.0)
	# The oompa theme belongs to the menu screens. Silence it for gameplay so
	# the stingers and footsteps come through clearly. The menu re-arms it on
	# its _ready when the player returns.
	AudioBus.stop_music()
	if online_mode:
		_start_online()
	else:
		_start_offline()

func _setup_menu() -> void:
	menu = IN_GAME_MENU.instantiate()
	add_child(menu)
	menu.resume_requested.connect(_on_menu_resume)
	menu.quit_to_menu_requested.connect(_on_menu_quit)

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_pause") and not menu.visible:
		menu.open()
		get_viewport().set_input_as_handled()

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

func _process(delta: float) -> void:
	if online_mode:
		_drive_online_hud()
		# The authoritative XZ advances at 60 Hz inside _advance_predicted_tick
		# (called from _stream_input). This per-render-frame call only
		# interpolates the body's visual transform between consecutive ticks
		# so the motion stays smooth on high-refresh monitors without
		# diverging from what the server applies.
		if (
			snapshot_received
			and local_player != null
			and not local_player.frozen
		):
			_advance_local_prediction(delta)
	else:
		_drive_offline_hud()

func _physics_process(delta: float) -> void:
	if local_player == null or topology == null:
		return
	var wrapped: Vector3 = topology.wrap(local_player.global_position)
	if wrapped != local_player.global_position:
		# Topology actually teleported us across a seam (torus, klein). Direct
		# global_position writes bypass collision, so settle the body into the
		# new space in case it landed inside a wall on the far side.
		local_player.global_position = wrapped
		local_player.settle_into_world()
	if not local_player.frozen:
		_check_contact_interactions()
	if online_mode and snapshot_received:
		# Network send still goes through _physics_process at 60 Hz; the
		# 20 Hz tick accumulator inside _stream_input owns when to flush.
		_stream_input(delta)
		_drive_keepalive(delta)

# Periodic ping while the WS is open. The 60 Hz input stream is implicit
# keepalive while the player is moving, but an idle player would otherwise
# leave the socket silent long enough for Cloudflare to retire the Durable
# Object connection.
func _drive_keepalive(delta: float) -> void:
	if room_client == null or not room_client.is_connected_to_server():
		_ping_accumulator = 0.0
		return
	_ping_accumulator += delta
	if _ping_accumulator < PING_INTERVAL_S:
		return
	_ping_accumulator = 0.0
	room_client.send_ping()

# ---------------------------------------------------------------------------
# Offline path
# ---------------------------------------------------------------------------

func _start_offline() -> void:
	topology = TopologyFactory.from_string(GameState.topology_as_string())
	hud.set_topology(topology.name())
	_build_labyrinth(_derive_offline_seed())
	_setup_rules()
	_spawn_offline_players()
	rules.start(topology)

func _setup_rules() -> void:
	rules = GameRulesScript.new()
	add_child(rules)
	rules.topology = topology
	rules.tagged.connect(_on_offline_tagged)
	rules.saved.connect(_on_offline_saved)
	rules.won.connect(_on_offline_won)
	rules.phase_changed.connect(_on_offline_phase_changed)

func _spawn_offline_players() -> void:
	GameState.ensure_username()
	local_player_id = "local"
	_spawn_player(local_player_id, GameState.username, "mime", false, true)
	for i in BOT_COUNT_PER_TEAM - 1:
		_spawn_player("mime_bot_%d" % i, UsernameGenerator.generate(), "mime", true, false)
	for i in BOT_COUNT_PER_TEAM:
		_spawn_player("clown_bot_%d" % i, UsernameGenerator.generate(), "clown", true, false)
	for id in player_nodes.keys():
		var node: Node = player_nodes[id]
		rules.register_player(id, node.team, node.global_position, node.display_name, node.bot)
		if node.bot:
			_attach_bot_ai(node, id)
	_render_team_status_offline()

func _attach_bot_ai(node: Node, id: String) -> void:
	var ai := BotAIScript.new()
	node.add_child(ai)
	ai.attach(node, id, rules, topology, labyrinth)

func _drive_offline_hud() -> void:
	if rules == null:
		return
	for id in player_nodes.keys():
		rules.update_position(id, player_nodes[id].global_position)
	rules.tick(Time.get_unix_time_from_system())
	hud.set_countdown_seconds(rules.phase_time_remaining(Time.get_unix_time_from_system()))

# ---------------------------------------------------------------------------
# Online path
# ---------------------------------------------------------------------------

func _start_online() -> void:
	hud.append_log("Connecting...")
	room_client = RoomClientScript.new()
	add_child(room_client)
	room_client.connected.connect(_on_room_connected)
	room_client.disconnected.connect(_on_room_disconnected)
	room_client.snapshot_received.connect(_on_snapshot)
	room_client.delta_received.connect(_on_delta)
	room_client.event_received.connect(_on_room_event)
	room_client.error_received.connect(_on_room_error)
	room_client.connect_to(GameState.server_url)

func _on_room_connected() -> void:
	GameState.ensure_username()
	# Pass the host token (empty for JOIN / OPEN modes, present only for the
	# HOST mode lobby). Server uses it to mark this connection as the host
	# and gate the start_match message to that one player.
	room_client.send_join(GameState.username, "", GameState.host_token)
	# Reset the reconnect ladder so the next disconnect starts fresh from the
	# shortest backoff window.
	_reconnect_attempt = 0
	_reconnect_active = false
	_hide_reconnect_banner()
	# Backward-compat hook for the legacy "host clicks Start in the lobby
	# and the arena starts solo" flow. Once the lobby UX in #102 lands the
	# host will press Start in the lobby itself; until then, the host's
	# arena _start_online immediately tells the room to begin so the
	# server's hosted-room path does not strand the host in `filling`.
	if GameState.mode == GameState.Mode.HOST and not GameState.host_token.is_empty():
		room_client.send_start_match()

func _on_room_disconnected(reason: String) -> void:
	# Most disconnects in the wild are transient: Cloudflare Durable Object
	# migration, brief ISP wobble, or a TLS fatal alert from CF retiring the
	# socket. Try a short ladder of reconnect attempts before showing the
	# player a hard choice, instead of force-bouncing back to the menu.
	if _reconnect_active:
		return
	_reconnect_active = true
	_reconnect_attempt = 0
	_show_reconnect_banner("Reconnecting...")
	hud.append_log("Disconnected: %s" % reason)
	_schedule_next_reconnect()

func _schedule_next_reconnect() -> void:
	if _reconnect_attempt >= RECONNECT_BACKOFF_S.size():
		_show_reconnect_failed_popup()
		return
	var wait_s: float = RECONNECT_BACKOFF_S[_reconnect_attempt]
	_reconnect_attempt += 1
	await get_tree().create_timer(wait_s).timeout
	if not _reconnect_active or room_client == null:
		return
	# Clear stale per-session state so reconciliation does not replay inputs
	# from before the drop. The fresh snapshot from the server's onJoin will
	# repopulate everything.
	pending_inputs.clear()
	snapshot_received = false
	room_client.connect_to(GameState.server_url)
	# If the connect call dispatches another `disconnected` immediately
	# (handshake failure), _on_room_disconnected re-enters; otherwise wait
	# for `connected` to flip us out of the reconnect state. As a backstop
	# in case neither fires (socket stuck pending), schedule the next ladder
	# step after the same backoff window.
	await get_tree().create_timer(wait_s + 1.0).timeout
	if _reconnect_active and not room_client.is_connected_to_server():
		_schedule_next_reconnect()

func _show_reconnect_banner(text: String) -> void:
	if _reconnect_label == null:
		_reconnect_label = Label.new()
		_reconnect_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_reconnect_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		_reconnect_label.anchor_left = 0.0
		_reconnect_label.anchor_right = 1.0
		_reconnect_label.anchor_top = 0.45
		_reconnect_label.anchor_bottom = 0.55
		_reconnect_label.add_theme_font_size_override("font_size", 48)
		hud.add_child(_reconnect_label)
	_reconnect_label.text = text
	_reconnect_label.visible = true

func _hide_reconnect_banner() -> void:
	if _reconnect_label != null:
		_reconnect_label.visible = false

func _show_reconnect_failed_popup() -> void:
	_hide_reconnect_banner()
	var dialog := AcceptDialog.new()
	dialog.title = "Connection lost"
	dialog.dialog_text = "Could not reach the server. Try again or back out to the main menu."
	dialog.ok_button_text = "Back to menu"
	dialog.unresizable = true
	var retry_button := dialog.add_button("Reconnect", true, "retry")
	retry_button.pressed.connect(_on_reconnect_retry_pressed.bind(dialog))
	dialog.confirmed.connect(_on_reconnect_give_up)
	add_child(dialog)
	dialog.popup_centered()

func _on_reconnect_retry_pressed(dialog: AcceptDialog) -> void:
	dialog.queue_free()
	_reconnect_attempt = 0
	_show_reconnect_banner("Reconnecting...")
	_schedule_next_reconnect()

func _on_reconnect_give_up() -> void:
	_reconnect_active = false
	_on_back_to_menu()

func _on_snapshot(snapshot: Dictionary, you_are: String) -> void:
	local_player_id = you_are
	var topology_name: String = snapshot.get("topology", "plane")
	topology = TopologyFactory.from_string(topology_name)
	GameState.set_topology(_topology_kind(topology_name))
	hud.set_topology(topology_name)
	if labyrinth == null:
		_build_labyrinth(int(snapshot.get("seed", 0)))
	_sync_players_from_snapshot(snapshot.get("players", []))
	phase_label = snapshot.get("phase", "")
	turn_ends_at_ms = int(snapshot.get("turnEndsAt", 0))
	snapshot_received = true
	# Adopt the server's authoritative spawn coordinates for the local player.
	# Without this the client-jittered spawn from _spawn_player can sit a few
	# units off the server's jitter, and the first deltas would dump us
	# through a wall while reconciling. Reset the input buffer too: any
	# inputs sent before the snapshot arrived describe motion from a
	# different origin and replaying them would compound the offset.
	pending_inputs.clear()
	for entry in snapshot.get("players", []):
		if entry.get("id", "") == local_player_id and local_player != null:
			var pos: Dictionary = entry.get("position", {"x": 0.0, "z": 0.0})
			var spawn_xz := Vector2(float(pos.get("x", 0.0)), float(pos.get("z", 0.0)))
			local_player.global_position = Vector3(
				spawn_xz.x, local_player.global_position.y, spawn_xz.y
			)
			local_sprint_energy = float(entry.get("sprintEnergy", 100.0))
			local_sprinting = bool(entry.get("sprinting", false))
			_pred_prev_xz = spawn_xz
			_pred_current_xz = spawn_xz
			_pred_tick_start_t = Time.get_unix_time_from_system()
			_pred_armed = true
			break

func _on_delta(delta: Dictionary) -> void:
	if not snapshot_received:
		return
	phase_label = delta.get("phase", phase_label)
	turn_ends_at_ms = int(delta.get("turnEndsAt", turn_ends_at_ms))
	# Server's delta carries the full player roster every tick. Use the
	# snapshot-style sync so newly-arrived bots get a Player node spawned
	# (otherwise _apply_player_state silently skips them and the lobby looks
	# empty until someone else joins).
	_sync_players_from_snapshot(delta.get("players", []))
	_reconcile_local_player(delta)

func _reconcile_local_player(delta: Dictionary) -> void:
	# Snap to the server's authoritative position for the local player, then
	# replay every input the server has not yet acknowledged so the rendered
	# position matches what we predict the server will compute next tick.
	# Without this the client-only prediction (this file's _stream_input loop
	# and the server's simulateHumans) drift apart whenever wall slides or
	# wrap behavior diverges, and tag distance checks fail with distances of
	# 30+ units because attacker.position is stale on the server side.
	if local_player == null or labyrinth == null or topology == null:
		return
	var ack_seq: int = int(delta.get("ackSeq", 0))
	var server_local: Dictionary = {}
	for entry in delta.get("players", []):
		if entry.get("id", "") == local_player_id:
			server_local = entry
			break
	if server_local.is_empty():
		return
	var pos_dict: Dictionary = server_local.get("position", {"x": 0.0, "z": 0.0})
	var server_pos := Vector2(float(pos_dict.get("x", 0.0)), float(pos_dict.get("z", 0.0)))
	# Drop inputs the server has applied; replay the rest.
	while pending_inputs.size() > 0 and int(pending_inputs[0]["seq"]) <= ack_seq:
		pending_inputs.pop_front()
	var server_sprint: float = float(server_local.get("sprintEnergy", local_sprint_energy))
	local_sprint_energy = server_sprint
	local_sprinting = bool(server_local.get("sprinting", local_sprinting))
	var walls: Array = labyrinth.wall_endpoints()
	var replayed_pos: Vector2 = server_pos
	for entry in pending_inputs:
		var step := Movement.step(
			{
				"position": replayed_pos,
				"sprint_energy": local_sprint_energy,
				"sprinting": local_sprinting,
			},
			{
				"move": entry["world_move"],
				"sprint": entry["sprint"],
				"dt": entry["dt"],
			},
			walls,
			topology,
		)
		replayed_pos = step["position"]
		local_sprint_energy = step["sprint_energy"]
		local_sprinting = bool(step["sprinting"])
	# Both sides run the same stepMovement, so the replayed position is
	# usually within a few cm of the local prediction. Rather than snapping
	# straight to it, set replayed_pos as the new "end of tick" target and
	# anchor "start of tick" to where the body is rendered right now. The
	# next render frames lerp from current visual position to the corrected
	# target over one tick window, turning a 5 cm correction into a smooth
	# slide instead of a visible pop.
	_pred_prev_xz = Vector2(local_player.global_position.x, local_player.global_position.z)
	_pred_current_xz = replayed_pos
	_pred_tick_start_t = Time.get_unix_time_from_system()
	_pred_armed = true

func _on_room_event(event: Dictionary) -> void:
	match event.get("kind", event.get("t", "")):
		"tagged": _handle_tagged(event)
		"saved": _handle_saved(event)
		"win": _handle_win(event)
		"phase": _handle_phase_event(event.get("phase", ""), int(event.get("cryIndex", -1)))

func _handle_phase_event(phase: String, cry_index: int) -> void:
	# Server sends 'turn_mime' / 'turn_clown' for the active-turn phases plus a
	# server-picked cryIndex so every client renders the same banner text. If
	# the server omits cryIndex (pre-cryIndex room build), falls back to slot 0
	# rather than a per-client random pick that would diverge across players.
	if phase == "turn_mime":
		var idx: int = cry_index if cry_index >= 0 else 0
		hud.flash_battle_cry(MIME_BATTLE_CRIES[idx % MIME_BATTLE_CRIES.size()], "mime")
	elif phase == "turn_clown":
		var idx: int = cry_index if cry_index >= 0 else 0
		hud.flash_battle_cry(CLOWN_BATTLE_CRIES[idx % CLOWN_BATTLE_CRIES.size()], "clown")
	elif phase == "free_roam":
		hud.flash_disperse()

const VersionCheck := preload("res://scripts/network/version_check.gd")

func _on_room_error(code: String, message: String) -> void:
	if code == "version_mismatch":
		_show_version_mismatch_popup(message)
		return
	hud.append_log("Server error %s: %s" % [code, message])

func _show_version_mismatch_popup(server_message: String) -> void:
	# Hard variant of the main-menu update popup. The server has refused to
	# play with this client because the protocol does not match. Tell the
	# player and offer one button to the website where the latest build lives.
	var dialog := AcceptDialog.new()
	dialog.title = "Update required"
	var local: String = VersionCheck.local_version()
	dialog.dialog_text = (
		"This server needs a newer client (you have v%s).\n\n%s"
		% [local, server_message]
	)
	dialog.ok_button_text = "Close"
	dialog.unresizable = true
	var open_button := dialog.add_button("Get latest", true, "open_site")
	open_button.pressed.connect(func(): OS.shell_open(VersionCheck.WEBSITE_URL))
	add_child(dialog)
	dialog.popup_centered()

func _drive_online_hud() -> void:
	if not snapshot_received:
		return
	var now_ms: float = Time.get_unix_time_from_system() * 1000.0
	var remaining_s: float = max(0.0, (turn_ends_at_ms - now_ms) / 1000.0)
	hud.set_countdown_seconds(remaining_s)

## Render-frame visual interpolation between consecutive tick-bound predictions.
## The authoritative XZ advances once per physics tick inside
## _advance_predicted_tick; this function only smooths the rendered body
## transform between those samples so a >60 Hz monitor stays fluid without
## diverging from what the server sees.
func _advance_local_prediction(_delta: float) -> void:
	if local_player == null or not _pred_armed:
		return
	var alpha: float = clampf(
		(Time.get_unix_time_from_system() - _pred_tick_start_t) / INPUT_TICK_PERIOD,
		0.0,
		1.0,
	)
	# Topology wraps land prev and current on opposite ends of the playfield;
	# lerping across them would shoot the body through the world. Detect the
	# discontinuity by step size: a single physics tick at sprint speed travels
	# ~0.1 m, so anything past 1 m means the step wrapped (or reconciliation
	# placed the new authoritative position far from the rendered one).
	var rendered_xz: Vector2
	if (_pred_current_xz - _pred_prev_xz).length() > 1.0:
		rendered_xz = _pred_current_xz
	else:
		rendered_xz = _pred_prev_xz.lerp(_pred_current_xz, alpha)
	local_player.global_position = Vector3(
		rendered_xz.x, local_player.global_position.y, rendered_xz.y
	)

## Advance the authoritative predicted position by one server-tick worth of
## motion. Called once per physics tick from _stream_input, matching the
## cadence the server uses to apply inputs. _process visually interpolates
## between consecutive samples.
func _advance_predicted_tick(world_move: Vector2, sprint_held: bool) -> void:
	if local_player == null or labyrinth == null or topology == null:
		return
	var step := Movement.step(
		{
			"position": _pred_current_xz,
			"sprint_energy": local_sprint_energy,
			"sprinting": local_sprinting,
		},
		{"move": world_move, "sprint": sprint_held, "dt": INPUT_TICK_PERIOD},
		labyrinth.wall_endpoints(),
		topology,
	)
	_pred_prev_xz = _pred_current_xz
	_pred_current_xz = step["position"]
	_pred_tick_start_t = Time.get_unix_time_from_system()
	local_sprint_energy = step["sprint_energy"]
	local_sprinting = bool(step["sprinting"])
	var planar: float = (_pred_current_xz - _pred_prev_xz).length() / INPUT_TICK_PERIOD
	local_player.set_external_motion(planar, local_sprinting and world_move.length() > 0.0)

func _stream_input(delta: float) -> void:
	input_accumulator += delta
	if input_accumulator < INPUT_TICK_PERIOD:
		return
	# Carry over the remainder so the average tick rate stays at 20 Hz even
	# when physics frames don't land exactly on tick boundaries.
	input_accumulator -= INPUT_TICK_PERIOD
	input_seq += 1
	# Sample WASD in player-local axes, then rotate into world XZ. Server and
	# client both treat input.move as world-space, so reconciliation replay
	# does not need to know the player's yaw at each historical tick.
	var wasd: Vector2 = _sample_move_intent()
	var yaw: float = local_player.rotation.y
	var world_move: Vector2 = _rotate_wasd_to_world(wasd, yaw)
	var sprinting: bool = (
		Input.is_action_pressed("sprint") and _input_active() and wasd.length() > 0.0
	)
	# Frozen players don't move on the server, so don't queue motion in the
	# buffer either; otherwise replay after a delta would walk us forward
	# from where the server kept us put.
	var frozen: bool = bool(local_player.frozen)
	var effective_move: Vector2 = Vector2.ZERO if frozen else world_move
	var effective_sprint: bool = false if frozen else sprinting
	pending_inputs.append({
		"seq": input_seq,
		"world_move": effective_move,
		"sprint": effective_sprint,
		"dt": INPUT_TICK_PERIOD,
	})
	room_client.send_input(input_seq, INPUT_TICK_PERIOD, effective_move, yaw, sprinting)
	# Advance the authoritative predicted XZ by exactly the same input the
	# server will apply. The render loop interpolates between consecutive
	# samples in _advance_local_prediction so the body still updates smoothly
	# at >60 Hz refresh rates.
	_advance_predicted_tick(effective_move, effective_sprint)

func _rotate_wasd_to_world(wasd: Vector2, yaw: float) -> Vector2:
	# wasd.x = right input strength, wasd.y = back-minus-forward. Map to a
	# player-local 3D dir then rotate by yaw around Y, matching the
	# transform.basis * input_dir that the offline path uses in player.gd.
	var cy: float = cos(yaw)
	var sy: float = sin(yaw)
	var lx: float = wasd.x
	var lz: float = wasd.y
	return Vector2(cy * lx + sy * lz, -sy * lx + cy * lz)

func _sync_players_from_snapshot(entries: Array) -> void:
	var seen: Dictionary = {}
	for entry in entries:
		var id: String = entry.get("id", "")
		if id.is_empty():
			continue
		seen[id] = true
		if not player_nodes.has(id):
			_spawn_player(
				id,
				entry.get("name", "?"),
				entry.get("team", "mime"),
				bool(entry.get("bot", false)),
				id == local_player_id,
			)
		_apply_player_state(entry)
	for id in player_nodes.keys():
		if not seen.has(id):
			player_nodes[id].queue_free()
			player_nodes.erase(id)
	_render_team_status_online(entries)

func _apply_player_state(entry: Dictionary) -> void:
	var id: String = entry.get("id", "")
	var node: Node = player_nodes.get(id)
	if node == null:
		return
	var pos: Dictionary = entry.get("position", {"x": 0.0, "z": 0.0})
	var pos_vec := Vector3(float(pos.get("x", 0.0)), 0.0, float(pos.get("z", 0.0)))
	var yaw: float = float(entry.get("yaw", 0.0))
	var is_frozen: bool = bool(entry.get("frozen", false))
	var sprint: float = float(entry.get("sprintEnergy", 100.0))
	if id == local_player_id:
		# Don't overwrite the local player's predicted position; sync the
		# server-authoritative bits that the client cannot derive on its own.
		node.frozen = is_frozen
		node.sprint_energy = sprint
	else:
		node.apply_remote_state(pos_vec, yaw, is_frozen, sprint)

func _handle_tagged(event: Dictionary) -> void:
	var victim_id: String = event.get("victimId", "")
	var attacker_id: String = event.get("attackerId", "")
	var team: String = event.get("team", "mime")
	var node: Node = player_nodes.get(victim_id)
	if node != null:
		node.frozen = true
	var verb: String = "mimed" if team == "mime" else "clowned"
	hud.append_log("%s was %s by %s" % [_name_for(victim_id), verb, _name_for(attacker_id)])
	if victim_id == local_player_id:
		hud.flash_frozen(team, _name_for(attacker_id))

func _handle_saved(event: Dictionary) -> void:
	var victim_id: String = event.get("victimId", "")
	var savior_id: String = event.get("saviorId", "")
	var node: Node = player_nodes.get(victim_id)
	if node != null:
		node.frozen = false
	hud.append_log("%s saved %s" % [_name_for(savior_id), _name_for(victim_id)])
	if victim_id == local_player_id:
		hud.clear_frozen_overlay()

func _handle_win(event: Dictionary) -> void:
	var team: String = event.get("team", "")
	var victory: bool = local_player != null and team == local_player.team
	hud.show_end(victory)
	_play_stinger(victory)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

func _build_labyrinth(seed_value: int) -> void:
	var node: Node3D = LABYRINTH.instantiate()
	labyrinth_holder.add_child(node)
	labyrinth = node
	labyrinth.build(seed_value, topology)

func _derive_offline_seed() -> int:
	if GameState.lobby_code.is_empty():
		return randi()
	return GameState.lobby_code.hash() & 0x7fffffff

func _spawn_player(id: String, p_name: String, team: String, is_bot: bool, is_local: bool) -> void:
	var p: Node = PLAYER.instantiate()
	p.team = team
	p.bot = is_bot
	p.is_local = is_local
	p.display_name = p_name
	world.add_child(p)
	# The grid maze places walls on cell boundaries every 8 units, including
	# a wall right through the origin. Spawning at origin would drop players
	# straight onto a wall seam. Push each team into the open interior of a
	# cell, and jitter inside SPAWN_RADIUS (still well clear of cell walls
	# since cells are 8 wide and SPAWN_RADIUS is 2.5).
	var team_offset: Vector3 = _team_spawn_offset(team)
	var angle: float = randf() * TAU
	var radius: float = randf() * SPAWN_RADIUS
	p.global_position = (
		spawn.global_position + team_offset
		+ Vector3(cos(angle) * radius, 0.0, sin(angle) * radius)
	)
	# Spawn position is computed in code; the body is dropped in by direct
	# assignment, which bypasses collision. Run a recovery pass so the new
	# capsule is not interpenetrating any wall it happened to land near.
	p.settle_into_world()
	player_nodes[id] = p
	if is_local:
		local_player = p
		# In online mode, arena.gd's predictor owns the X/Z position; flag the
		# body so player.gd skips its own input-driven move_and_slide and
		# avoids double-walking.
		p.predicted_externally = online_mode
		p.sprint_changed.connect(hud.set_sprint)
		p.frozen_changed.connect(_on_local_frozen_changed)
		hud.set_local_team(team)

func _team_spawn_offset(team: String) -> Vector3:
	# Mimes land at cell (3, 5) center, clowns at cell (6, 5) center. Both are
	# interior cells of the 10x10 grid (cell size 8.0) so the spawn jitter
	# stays away from any wall on the cell boundary.
	if team == "mime":
		return Vector3(-12.0, 0.0, 4.0)
	return Vector3(12.0, 0.0, 4.0)

# ---------------------------------------------------------------------------
# Contact interactions
# ---------------------------------------------------------------------------

func _check_contact_interactions() -> void:
	var active: String = _active_team()
	var now: float = Time.get_unix_time_from_system()
	for id in player_nodes.keys():
		if id == local_player_id:
			continue
		var node: Node = player_nodes[id]
		var dist: float = topology.distance(local_player.global_position, node.global_position)
		if dist > CONTACT_RADIUS:
			continue
		if now - float(contact_cooldowns.get(id, 0.0)) < CONTACT_COOLDOWN_S:
			continue
		if _attempt_interaction(id, node, active):
			contact_cooldowns[id] = now

func _attempt_interaction(id: String, node: Node, active: String) -> bool:
	if active == local_player.team and node.team != local_player.team and not node.frozen:
		return _send_tag(id)
	if node.team == local_player.team and node.frozen:
		return _send_unfreeze(id)
	return false

func _active_team() -> String:
	if online_mode:
		match phase_label:
			"turn_mime": return "mime"
			"turn_clown": return "clown"
		return ""
	return rules.active_team()

func _send_tag(target_id: String) -> bool:
	if online_mode:
		room_client.send_tag(target_id)
		return true
	return rules.try_tag(local_player_id, target_id)

func _send_unfreeze(target_id: String) -> bool:
	if online_mode:
		room_client.send_unfreeze(target_id)
		return true
	return rules.try_unfreeze(local_player_id, target_id)

# ---------------------------------------------------------------------------
# Offline event handlers
# ---------------------------------------------------------------------------

func _on_offline_tagged(victim_id: String, attacker_id: String, team: String) -> void:
	var victim: Node = player_nodes.get(victim_id)
	if victim != null:
		victim.frozen = true
	var attacker_info: Dictionary = rules.players.get(attacker_id, {})
	var victim_info: Dictionary = rules.players.get(victim_id, {})
	var verb: String = "mimed" if team == "mime" else "clowned"
	hud.append_log("%s was %s by %s" % [victim_info.get("name", "?"), verb, attacker_info.get("name", "?")])
	if victim_id == local_player_id:
		hud.flash_frozen(team, attacker_info.get("name", "?"))
	_render_team_status_offline()

func _on_offline_saved(victim_id: String, savior_id: String) -> void:
	var victim: Node = player_nodes.get(victim_id)
	if victim != null:
		victim.frozen = false
	var savior_info: Dictionary = rules.players.get(savior_id, {})
	var victim_info: Dictionary = rules.players.get(victim_id, {})
	hud.append_log("%s saved %s" % [savior_info.get("name", "?"), victim_info.get("name", "?")])
	if victim_id == local_player_id:
		hud.clear_frozen_overlay()
	_render_team_status_offline()

func _on_offline_won(team: String) -> void:
	var victory: bool = team == local_player.team
	hud.show_end(victory)
	_play_stinger(victory)

func _on_offline_phase_changed(phase: int) -> void:
	match phase:
		GameRulesScript.Phase.FREE_ROAM:
			hud.flash_disperse()
		GameRulesScript.Phase.TURN_MIME:
			hud.flash_battle_cry(MIME_BATTLE_CRIES[randi() % MIME_BATTLE_CRIES.size()], "mime")
		GameRulesScript.Phase.TURN_CLOWN:
			hud.flash_battle_cry(CLOWN_BATTLE_CRIES[randi() % CLOWN_BATTLE_CRIES.size()], "clown")

# ---------------------------------------------------------------------------
# HUD helpers
# ---------------------------------------------------------------------------

func _on_local_frozen_changed(is_frozen: bool) -> void:
	if not is_frozen:
		hud.clear_frozen_overlay()

func _render_team_status_offline() -> void:
	var list: Array = []
	for player in rules.players.values():
		list.append(player)
	hud.render_team_status(list)

func _render_team_status_online(entries: Array) -> void:
	hud.render_team_status(entries)

func _name_for(id: String) -> String:
	var node: Node = player_nodes.get(id)
	if node == null:
		return id
	return node.display_name

# ---------------------------------------------------------------------------
# Audio and scene transitions
# ---------------------------------------------------------------------------

func _play_stinger(victory: bool) -> void:
	AudioBus.set_bus_volume("Music", -10.0)
	var stinger_path: String = AssetPaths.WIN_STINGER if victory else AssetPaths.LOSE_STINGER
	var stinger: AudioStream = AssetPaths.try_load_audio(stinger_path)
	if stinger == null:
		# Restore the duck even when there is no stinger to play, otherwise the
		# Music bus stays muted for the rest of the session.
		AudioBus.set_bus_volume("Music", 0.0)
		return
	var player := AudioStreamPlayer.new()
	player.bus = "SFX"
	player.stream = stinger
	add_child(player)
	player.play()
	player.finished.connect(func() -> void:
		AudioBus.set_bus_volume("Music", 0.0)
		player.queue_free()
	)

func _on_back_to_menu() -> void:
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	if room_client != null:
		room_client.disconnect_from()
	requested_screen.emit("menu")

func _on_menu_resume() -> void:
	menu.close()

func _on_menu_quit() -> void:
	menu.close()
	_on_back_to_menu()

# ---------------------------------------------------------------------------
# Misc utilities
# ---------------------------------------------------------------------------

func _topology_kind(name: String) -> int:
	match name:
		"torus": return GameState.Topology.TORUS
		"mobius": return GameState.Topology.MOBIUS
		"klein": return GameState.Topology.KLEIN
		_: return GameState.Topology.PLANE

func _sample_move_intent() -> Vector2:
	if not _input_active():
		return Vector2.ZERO
	var v := Vector2.ZERO
	v.y -= Input.get_action_strength("move_forward")
	v.y += Input.get_action_strength("move_back")
	v.x -= Input.get_action_strength("move_left")
	v.x += Input.get_action_strength("move_right")
	return v

func _input_active() -> bool:
	return Input.get_mouse_mode() == Input.MOUSE_MODE_CAPTURED
