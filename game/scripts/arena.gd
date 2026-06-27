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
const Physics := preload("res://scripts/physics.gd")
const IN_GAME_MENU := preload("res://scenes/in_game_menu.tscn")
const TUTORIAL_OVERLAY := preload("res://scenes/tutorial_overlay.tscn")
# Preload kept here only for the `var rules: GameRulesScript` field
# type annotation - OfflineMode (offline_mode.gd) is the actual lifecycle
# owner and instantiates the GameRulesScript; contact_interactions.gd
# then reads arena.rules without needing to know about OfflineMode.
const GameRulesScript := preload("res://scripts/game_rules.gd")
const PlayerScript := preload("res://scripts/player.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")
const AssetPaths := preload("res://scripts/asset_paths.gd")
const RoomClientScript := preload("res://scripts/network/room_client.gd")
const OnlinePredictorScript := preload("res://scripts/online_predictor.gd")
const ReconnectControllerScript := preload("res://scripts/reconnect_controller.gd")
const ContactInteractionsScript := preload("res://scripts/contact_interactions.gd")
const OfflineModeScript := preload("res://scripts/offline_mode.gd")
const ProjectileRendererScript := preload("res://scripts/projectile_renderer.gd")
const ItemRendererScript := preload("res://scripts/item_renderer.gd")
const PortalRendererScript := preload("res://scripts/portal_renderer.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")
const Spectator := preload("res://scripts/spectator.gd")

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# BOT_COUNT_PER_TEAM moved into offline_mode.gd (only consumer).
const SPAWN_RADIUS := 2.5
# CONTACT_RADIUS / CONTACT_COOLDOWN_S + tag/save logic live in
# game/scripts/contact_interactions.gd.
## Client input cadence. Matches the server's TICK_HZ in
## backend/room/src/room.ts so each server tick consumes exactly one input
## (one stepMovement call) on average. Going lower would queue inputs on the
## server and lag reconciliation; going higher would skip inputs because the
## server only applies the most recent input per tick.
const INPUT_TICK_HZ := 60.0
const INPUT_TICK_PERIOD := 1.0 / INPUT_TICK_HZ

# Hard cap on un-acked inputs held for reconciliation replay. Normal RTT
# keeps this under a dozen entries; this only bites when the server stops
# advancing ackSeq (rate-limit rejection, overload, partition). Without it
# the buffer grows every tick and reconcile() replays the whole array each
# delta, so frame cost climbs until the client locks up. 240 = 4 s at
# INPUT_TICK_HZ, well beyond any real RTT; past that the oldest (already
# unrecoverable) inputs are dropped, matching the server's MAX_INPUT_QUEUE
# and the send queue's SEND_QUEUE_MAX bounding philosophy.
const MAX_PENDING_INPUTS := 240

# Keepalive ping interval + reconnect ladder constants live in
# game/scripts/reconnect_controller.gd.

# Environment palettes for the two arena looks. Toggled by the Settings
# overlay; apply_light_mode swaps between these wholesale. Pulled into named
# consts so a designer pass on the palette doesn't require fishing through
# if/else branches.
#
# FACILITY is the default: a dim, gloomy strip-lit test-chamber look. The maze
# is dark and moody; the wall-floor LED strips and the self-lit volumetric fog
# do the visual work rather than broad ambient light. The volumetric fog stays
# visible in the gloom because it carries its own emission (set in arena.tscn) -
# scene lighting alone would render it near black under Forward+. LIGHT is a
# bright outdoor-daylight variant for the toggle.
const LIGHT_BACKGROUND := Color(0.55, 0.75, 0.95)
const LIGHT_AMBIENT := Color(0.95, 0.95, 0.92)
const LIGHT_AMBIENT_ENERGY := 0.6
const LIGHT_FOG := Color(0.72, 0.82, 0.95)
const LIGHT_FOG_DENSITY := 0.006
const LIGHT_SUN_COLOR := Color(1.0, 0.98, 0.92)
const LIGHT_SUN_ENERGY := 1.0
const FACILITY_BACKGROUND := Color(0.05, 0.06, 0.08)
const FACILITY_AMBIENT := Color(0.42, 0.46, 0.55)
const FACILITY_AMBIENT_ENERGY := 0.22
const FACILITY_FOG := Color(0.08, 0.09, 0.12)
const FACILITY_FOG_DENSITY := 0.012
const FACILITY_SUN_COLOR := Color(0.82, 0.86, 0.95)
const FACILITY_SUN_ENERGY := 0.45
# Volumetric fog albedo per mode (separate from the classic distance fog
# above). Facility is a muted cool tone that, paired with the emission in the
# scene, reads as a moody haze in the gloom; daylight is a brighter blue.
const LIGHT_VOL_FOG := Color(0.78, 0.85, 0.95)
const FACILITY_VOL_FOG := Color(0.30, 0.34, 0.42)

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
var rules: GameRulesScript = null

# Online-only.
var room_client: Node = null
var online_mode: bool = false
var snapshot_received: bool = false
# Set once we begin swapping back to the lobby on a Play Again restart, so a
# second phase/snapshot in the same frame doesn't emit the screen change twice.
var returning_to_lobby: bool = false
# Set once a party member's post-match return to the party screen is scheduled,
# so a second win/phase event in the same frame doesn't queue it twice.
var _returning_to_party: bool = false
var phase_label: String = ""
var turn_ends_at_ms: int = 0
# Last phase the turn visuals (battle cry + light-band tint) were applied for.
# Both the phase event and every delta drive the visuals through one deduped
# path, so a missed/late phase event can't leave the cue a turn behind the
# authoritative phase the tag rules use.
var _last_visual_phase: String = ""
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

# Teammate-spectator camera (used while frozen). A standalone Camera3D driven to
# a watched teammate's eye + look each frame; remote bodies free their own
# camera, so we render their POV with this one rather than reusing theirs.
# _spectate_target is the body currently being watched, or null when off.
var _spectator_cam: Camera3D = null
var _spectate_target: Node = null
# True once the local player has been frozen long enough to switch into the
# teammate-spectator view (see SPECTATE_DELAY_S); cleared on unfreeze / match end.
var _spectate_active: bool = false
var _spectate_delay_timer: Timer = null
# Beat after freezing before the view switches, so the "you've been mimed by X"
# flash registers on the player's own POV first.
const SPECTATE_DELAY_S := 2.0

# Online local-player predictor. Owns _pred_* state + the three
# advance_tick / reconcile / advance_local_prediction methods. See
# game/scripts/online_predictor.gd for the full surface.
var predictor: OnlinePredictorScript = null

# Rising-edge tracker for the spacebar so holding the key sends exactly
# one jump=true input per press. Stays on arena because it's part of
# the input sampling pipeline, not predictor state. Reset when the
# player lets go.
var _jump_was_held: bool = false

# Rising-edge tracker for the shoot button so holding the mouse fires exactly
# one shot per press. The server also gates re-fires on its cooldown, but
# debouncing here keeps the wire stream to one shoot message per click.
var _shoot_was_held: bool = false
# Rising-edge tracker for the use-item key so holding E activates exactly once
# per press. The server no-ops a use_item with an empty slot anyway.
var _use_item_was_held: bool = false
# Last server-reported activeItem for the local player. Read on the use_item
# rising edge so a leap activation can arm the predictor's local leap
# prediction at the same moment the server sets leapArmed.
var _held_item: String = ""
# Wall-clock ms of the last shoot message sent. Mirrors the server's cooldown
# so rapid clicking doesn't spend wire frames on shots the server will reject.
var _last_shot_at_ms: int = -1000000
# Overcharge armed for the local player: the next shot skips the cooldown gate.
# Predicted client-side like leap - set on the use_item rising edge, cleared
# when the shot fires. The server is authoritative (its overchargeArmed gates
# the actual piercing shot); this flag only lets the client fire early without
# waiting a round-trip, so it isn't read back from the snapshot.
var _overcharge_armed: bool = false

# Online-only. Pooled sphere renderer for server-authoritative projectiles.
# Instantiated on the online path once World is ready; null in offline mode.
var projectile_renderer: RefCounted = null

# Online-only. Pooled floating-icon renderer for server-authoritative power-up
# items. Instantiated alongside projectile_renderer on the online path; null in
# offline mode.
var item_renderer: RefCounted = null

# Online-only. Pooled ring renderer for server-authoritative portal pairs.
# Instantiated alongside item_renderer on the online path; null in offline mode.
var portal_renderer: RefCounted = null

# Shared.
var local_player: PlayerScript = null
var local_player_id: String = ""
# Winning team once the match ends, "" while live. Lets a host_changed
# promotion that lands on the end screen re-show the overlay with Play Again.
var _ended_win_team: String = ""
# Telemetry: emit match_start at most once per match (reset on win / Play Again).
var _match_telemetry_emitted: bool = false
var player_nodes: Dictionary = {}
var contacts: ContactInteractionsScript = null
# OfflineMode owns the offline match lifecycle: rules wiring, bot
# spawning + AI, rule event handlers, team-status renders. Lives in
# game/scripts/offline_mode.gd. Instantiated in _ready as a child Node
# regardless of online_mode (idle when online; start() is the gate).
var offline: OfflineModeScript = null

# Keepalive ping + reconnect ladder + banner + connection-lost popup
# live in game/scripts/reconnect_controller.gd. Instantiated in _ready.
var reconnect: Node = null

# Suppress repeat tag-rejection HUD lines closer than this many seconds.
# Without this, walking into a wall while spamming the contact button
# spams the side log at 60Hz.
const TAG_REJECT_HUD_THROTTLE_S := 1.5
var _last_tag_reject_log_at: float = -1000.0

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

func _ready() -> void:
	# Group registration so the settings overlay can find the live arena
	# scene and re-apply visual prefs (light mode) without waiting for
	# the next match load.
	add_to_group("arena")
	# One-shot delay between freezing and switching to the teammate-spectator view.
	_spectate_delay_timer = Timer.new()
	_spectate_delay_timer.one_shot = true
	_spectate_delay_timer.wait_time = SPECTATE_DELAY_S
	_spectate_delay_timer.timeout.connect(_on_spectate_delay_elapsed)
	add_child(_spectate_delay_timer)
	online_mode = not GameState.server_url.is_empty()
	apply_light_mode(Settings.light_mode)
	_setup_menu()
	hud.play_again_requested.connect(_on_play_again)
	reconnect = ReconnectControllerScript.new()
	add_child(reconnect)
	reconnect.attach(self)
	contacts = ContactInteractionsScript.new(self)
	offline = OfflineModeScript.new()
	add_child(offline)
	offline.attach(self)
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
		offline.start()
	if not Settings.has_seen_tutorial:
		start_tutorial()

func start_tutorial() -> void:
	# Free any live overlay first so a restart never stacks instances.
	var existing := get_node_or_null("TutorialOverlay")
	if existing != null:
		existing.free()
	add_child(TUTORIAL_OVERLAY.instantiate())

func _setup_menu() -> void:
	menu = IN_GAME_MENU.instantiate()
	add_child(menu)
	menu.resume_requested.connect(_on_menu_resume)
	menu.quit_to_menu_requested.connect(_on_menu_quit)

func apply_light_mode(enabled: bool) -> void:
	# Re-skin the arena Environment + DirectionalLight to either the default
	# dim facility palette or the bright daylight palette. Called once on
	# _ready and again whenever Settings.light_mode toggles while a match is
	# in progress.
	var env_node: WorldEnvironment = get_node_or_null("Environment")
	var sun: DirectionalLight3D = get_node_or_null("DirectionalLight")
	if env_node == null or env_node.environment == null or sun == null:
		return
	var env: Environment = env_node.environment
	if enabled:
		env.background_color = LIGHT_BACKGROUND
		env.ambient_light_color = LIGHT_AMBIENT
		env.ambient_light_energy = LIGHT_AMBIENT_ENERGY
		env.fog_light_color = LIGHT_FOG
		env.fog_density = LIGHT_FOG_DENSITY
		env.volumetric_fog_albedo = LIGHT_VOL_FOG
		sun.light_energy = LIGHT_SUN_ENERGY
		sun.light_color = LIGHT_SUN_COLOR
	else:
		env.background_color = FACILITY_BACKGROUND
		env.ambient_light_color = FACILITY_AMBIENT
		env.ambient_light_energy = FACILITY_AMBIENT_ENERGY
		env.fog_light_color = FACILITY_FOG
		env.fog_density = FACILITY_FOG_DENSITY
		env.volumetric_fog_albedo = FACILITY_VOL_FOG
		sun.light_energy = FACILITY_SUN_ENERGY
		sun.light_color = FACILITY_SUN_COLOR

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_pause") and not menu.visible:
		menu.open()
		get_viewport().set_input_as_handled()

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

func _process(delta: float) -> void:
	# While in spectator mode (frozen past the delay), keep watching a valid
	# teammate: re-pick if ours left or got frozen, fall back to our own POV if
	# none are eligible, and glue the camera to the target's interpolated eye.
	if _spectate_active:
		_tick_spectate()
	if online_mode:
		_drive_online_hud()
		# The authoritative XZ advances at 60 Hz inside _advance_predicted_tick
		# (called from _stream_input). This per-render-frame call only
		# interpolates the body's visual transform between consecutive ticks
		# so the motion stays smooth on high-refresh monitors without
		# diverging from what the server applies.
		#
		# Runs even when frozen so the frozen-mid-jump Y-descent lerp inside
		# _advance_local_prediction can drop the body back to hover height.
		# The XZ side is harmless while frozen because _stream_input zeros
		# the input vectors (effective_move = Vector2.ZERO), so _pred_prev_xz
		# and _pred_current_xz stop advancing - rendering re-applies the
		# same XZ each frame.
		if snapshot_received and local_player != null:
			predictor.advance_local_prediction(delta)
		if projectile_renderer != null:
			projectile_renderer.tick(delta)
		if item_renderer != null:
			item_renderer.tick(delta)
		if portal_renderer != null:
			portal_renderer.tick(delta)
	else:
		offline.drive_hud(delta)

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
		contacts.check()
	if online_mode and snapshot_received:
		# Network send still goes through _physics_process at 60 Hz; the
		# 20 Hz tick accumulator inside _stream_input owns when to flush.
		_stream_input(delta)
		reconnect.drive_keepalive(delta)

# Offline path lives in game/scripts/offline_mode.gd. arena instantiates
# the OfflineMode node in _ready when GameState.server_url is empty.

# ---------------------------------------------------------------------------
# Online path
# ---------------------------------------------------------------------------

func _start_online() -> void:
	hud.append_log("Connecting...")
	projectile_renderer = ProjectileRendererScript.new(self)
	item_renderer = ItemRendererScript.new(self)
	portal_renderer = PortalRendererScript.new(self)
	hud.set_crosshair_visible(true)
	# The lobby already opened the WebSocket (and sent `join`) before
	# transitioning into the arena. Re-use that RoomClient so reconciliation
	# state and the initial snapshot survive the scene swap. Only fall back
	# to opening a fresh connection if the lobby was somehow skipped (e.g.,
	# direct boot into arena during development).
	if NetClient.is_open():
		room_client = NetClient.room_client
	else:
		# Fallback: lobby was skipped (development boot, or a future flow
		# that goes straight to arena). Build a RoomClient and register it
		# on NetClient so NetClient.close() can tear it down later.
		room_client = RoomClientScript.new()
		NetClient.add_child(room_client)
		NetClient.room_client = room_client
		room_client.connect_to(GameState.server_url)
	# Continue the connection's input seq instead of restarting at 0. On a Play
	# Again the same connection (and its server-side high-water mark) is reused,
	# so a rebuilt arena that reset to 0 would have every input rejected as
	# already-applied. room_client owns the counter and only zeroes it on a brand
	# new connection.
	input_seq = room_client.input_seq
	room_client.connected.connect(_on_room_connected)
	room_client.disconnected.connect(_on_room_disconnected)
	room_client.snapshot_received.connect(_on_snapshot)
	room_client.delta_received.connect(_on_delta)
	room_client.event_received.connect(_on_room_event)
	room_client.error_received.connect(_on_room_error)
	# If the connection is already up (lobby path), the snapshot has already
	# been delivered to the lobby and won't be re-emitted. NetClient caches
	# it for us - replay it now so spawn / topology / labyrinth construction
	# all happen as if we'd just received the message directly. The next
	# delta arriving here will then progress state normally. If the lobby
	# path was skipped (fallback above), wait for `connected` from
	# connect_to() and `_on_room_connected` will send the join.
	if room_client.is_connected_to_server():
		reconnect.handle_connected()
		if not NetClient.cached_snapshot.is_empty():
			_on_snapshot(NetClient.cached_snapshot, NetClient.cached_you_are)

func _on_room_connected() -> void:
	GameState.ensure_username()
	# Only fires on the fallback path where the arena opened the WS itself.
	# In the normal lobby path the WS was already connected and join was
	# sent before this scene loaded.
	room_client.send_join(
		GameState.username, "", GameState.host_token, GameState.party_id, GameState.party_size
	)
	reconnect.handle_connected()

func _on_room_disconnected(reason: String) -> void:
	# Most disconnects in the wild are transient: Cloudflare Durable Object
	# migration, brief ISP wobble, or a TLS fatal alert from CF retiring the
	# socket. The reconnect controller runs a short ladder before showing
	# the player a hard "Reconnect / Quit" choice. The HUD log line is held
	# back to the ladder-gives-up moment so transient blips don't surface
	# scary text the ladder absorbs invisibly.
	reconnect.handle_disconnected(reason)

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
	# Telemetry: the first play-phase snapshot marks the match start (once per
	# match; reset on win / Play Again).
	if (
		not _match_telemetry_emitted
		and phase_label != ""
		and phase_label != "filling"
		and phase_label != "ended"
	):
		_match_telemetry_emitted = true
		var humans := 0
		var bots := 0
		for e in snapshot.get("players", []):
			if e.get("bot", false):
				bots += 1
			else:
				humans += 1
		var mode_str := "open" if GameState.mode == GameState.Mode.OPEN else "private"
		Telemetry.track_match_start(topology_name, mode_str, humans, bots)
	# Adopt the server's authoritative spawn coordinates for the local player.
	# Without this the client-jittered spawn from _spawn_player can sit a few
	# units off the server's jitter, and the first deltas would dump us
	# through a wall while reconciling. Reset the input buffer too: any
	# inputs sent before the snapshot arrived describe motion from a
	# different origin and replaying them would compound the offset.
	pending_inputs.clear()
	contacts.reset_cooldowns()
	if projectile_renderer != null:
		projectile_renderer.clear()
	# Items ride the snapshot (static between pickups); reconcile the floor set.
	if item_renderer != null:
		item_renderer.render_from_snapshot(snapshot.get("items", []))
	if portal_renderer != null:
		portal_renderer.render_from_snapshot(snapshot.get("portals", []))
	for entry in snapshot.get("players", []):
		if entry.get("id", "") == local_player_id and local_player != null:
			var pos: Dictionary = entry.get("position", {"x": 0.0, "z": 0.0})
			var spawn_xz := Vector2(float(pos.get("x", 0.0)), float(pos.get("z", 0.0)))
			var spawn_y: float = float(pos.get("y", Physics.HOVER_HEIGHT))
			local_player.global_position = Vector3(spawn_xz.x, spawn_y, spawn_xz.y)
			local_sprint_energy = float(entry.get("sprintEnergy", 100.0))
			local_sprinting = bool(entry.get("sprinting", false))
			# Pull the server's authoritative jumpStartedAt (null on the
			# wire arrives as Variant null; treat as -1).
			var server_jump_started: Variant = entry.get("jumpStartedAt", null)
			var jump_started_at_ms: int = (
				int(server_jump_started) if server_jump_started != null else -1
			)
			if predictor == null:
				predictor = OnlinePredictorScript.new(self, INPUT_TICK_PERIOD)
			predictor.arm(spawn_xz, jump_started_at_ms)
			break

func _on_delta(delta: Dictionary) -> void:
	if not snapshot_received:
		return
	phase_label = delta.get("phase", phase_label)
	turn_ends_at_ms = int(delta.get("turnEndsAt", turn_ends_at_ms))
	# The phase rides every delta, so re-apply the turn cue from it: if the
	# discrete phase event was missed or late, the bands/cry would otherwise lag
	# the real phase and mislead the player about whose turn it is. Filling
	# (Play Again) is left to the event path, which swaps back to the lobby.
	if phase_label != "filling":
		_apply_phase_visuals(phase_label, -1)
	# Server's delta carries the full player roster every tick. Use the
	# snapshot-style sync so newly-arrived bots get a Player node spawned
	# (otherwise _apply_player_state silently skips them and the lobby looks
	# empty until someone else joins).
	_sync_players_from_snapshot(delta.get("players", []))
	if predictor != null:
		predictor.reconcile(delta)
	if projectile_renderer != null:
		# Field is omitted entirely when no projectiles are live; treat absent
		# as empty so the renderer hides any sphere that just terminated.
		projectile_renderer.render_from_delta(delta.get("projectiles", []))

func _on_room_event(event: Dictionary) -> void:
	match event.get("kind", event.get("t", "")):
		"tagged": _handle_tagged(event)
		"saved": _handle_saved(event)
		"win": _handle_win(event)
		"phase": _handle_phase_event(event.get("phase", ""), int(event.get("cryIndex", -1)))
		"tag_result": _handle_tag_result(event)
		"projectile_fired": _handle_projectile_fired(event)
		"projectile_hit": _handle_projectile_hit(event)
		"item_spawn": _handle_item_spawn(event)
		"item_pickup": _handle_item_pickup(event)
		"portal_open": _handle_portal_open(event)
		"portal_close": _handle_portal_close(event)
		"player_teleport": _handle_player_teleport(event)
		"host_changed": _handle_host_changed(event)

func _handle_projectile_fired(event: Dictionary) -> void:
	# Spawn the sphere instantly so the shooter sees their shot a frame after
	# the click instead of waiting for the next delta. The delta then keeps it
	# in sync with the authoritative path.
	if projectile_renderer != null:
		projectile_renderer.on_fired(event.get("projectile", {}))

func _handle_projectile_hit(event: Dictionary) -> void:
	# Hide the sphere the instant the server says it terminated (wall, enemy,
	# or expiry) rather than waiting for the next delta to drop it.
	if projectile_renderer != null:
		projectile_renderer.on_hit(String(event.get("projectileId", "")))

func _handle_item_spawn(event: Dictionary) -> void:
	# Show a respawned item instantly. The initial layout rides the snapshot;
	# only respawns arrive as item_spawn events.
	if item_renderer != null:
		item_renderer.on_spawn(event.get("item", {}))

func _handle_item_pickup(event: Dictionary) -> void:
	# Hide the picked-up item immediately. If the local player grabbed it, the
	# held-item HUD slot fills off the next delta's activeItem.
	if item_renderer != null:
		item_renderer.on_pickup(String(event.get("itemId", "")))

func _handle_portal_open(event: Dictionary) -> void:
	# Show the pair instantly. Live pairs also ride the snapshot, so a late
	# joiner / reconnect picks up an in-progress pair without this event.
	if portal_renderer != null:
		portal_renderer.on_open(event.get("portal", {}))

func _handle_portal_close(event: Dictionary) -> void:
	# Hide the pair the instant the server expires it rather than waiting for the
	# next snapshot to drop it.
	if portal_renderer != null:
		portal_renderer.on_close(String(event.get("id", "")))

func _handle_player_teleport(event: Dictionary) -> void:
	# Snap the local player's facing away from the exit wall. Only the local
	# body needs this: its yaw is client-owned (sampled from rotation.y each
	# input tick), so the server can't turn it through the delta the way it
	# does for remote bodies. Position still reconciles off the next delta.
	if String(event.get("playerId", "")) != local_player_id:
		return
	if local_player != null:
		local_player.rotation.y = float(event.get("yaw", local_player.rotation.y))

func _handle_host_changed(event: Dictionary) -> void:
	# The original host left and the server promoted a remaining human. If that
	# is us, take the host role so the end-screen Play Again shows up - even
	# though we never held a host token. If the match has already ended and the
	# overlay is up, re-show it with the button now enabled.
	if String(event.get("hostId", "")) != local_player_id or local_player_id.is_empty():
		return
	GameState.is_room_host = true
	if hud != null:
		hud.append_log("The host left - you're the host now.")
	# If the match already ended, the overlay is up without a Play Again button;
	# re-show it now that we can restart.
	if online_mode and hud != null and not _ended_win_team.is_empty():
		var victory: bool = local_player != null and _ended_win_team == local_player.team
		hud.show_end(victory, true)

func _handle_tag_result(event: Dictionary) -> void:
	if bool(event.get("ok", false)):
		return
	_surface_tag_reject(String(event.get("reason", "")))

# Maps server tag_result.reason codes to short HUD hints. Codes the
# player wouldn't act on (same_team, you_are_frozen, missing) stay
# silent. out_of_range fires on every near-miss so it's silent too;
# the reach is visually obvious. Throttled so contact spam at 60Hz
# doesn't fill the log.
func _surface_tag_reject(reason: String) -> void:
	var hint: String = ""
	if reason == "vertical_separation":
		hint = "Tag missed: out of reach (jumped)"
	elif reason == "wall_in_way":
		hint = "Tag blocked: wall in the way"
	elif reason == "just_saved":
		hint = "Just unfrozen - try again in a moment"
	elif reason == "not_your_turn":
		hint = "Wait for your team's turn"
	if hint.is_empty():
		return
	var now: float = Time.get_unix_time_from_system()
	if now - _last_tag_reject_log_at < TAG_REJECT_HUD_THROTTLE_S:
		return
	_last_tag_reject_log_at = now
	hud.append_log(hint)

func _handle_phase_event(phase: String, cry_index: int) -> void:
	# A drop back to `filling` means the host hit Play Again: the server reset
	# the room to a fresh lobby with the same roster. Swap back to the lobby
	# scene (keeping the live connection) rather than staying on the arena.
	if phase == "filling":
		_return_to_lobby()
		return
	# Server sends 'turn_mime' / 'turn_clown' for the active-turn phases plus a
	# server-picked cryIndex so every client renders the same banner text. If
	# the server omits cryIndex (pre-cryIndex room build), falls back to slot 0
	# rather than a per-client random pick that would diverge across players.
	_apply_phase_visuals(phase, cry_index)

# Apply the turn cue (battle cry + light-band tint) for a phase, once per change.
# Called both from the phase event (with the server's shared cryIndex) and from
# _on_delta (cry_index -1 -> deterministic slot 0) so the cue always reflects the
# authoritative phase even if the discrete phase event was missed or arrived
# late - otherwise the bands/cry could show one team's turn while the server (and
# the tag rules) had already moved to the other, making a player think it was
# their turn to tag when it wasn't.
func _apply_phase_visuals(phase: String, cry_index: int) -> void:
	if phase == _last_visual_phase:
		return
	_last_visual_phase = phase
	if phase == "turn_mime":
		var idx: int = cry_index if cry_index >= 0 else 0
		hud.flash_battle_cry(MIME_BATTLE_CRIES[idx % MIME_BATTLE_CRIES.size()], "mime")
	elif phase == "turn_clown":
		var idx: int = cry_index if cry_index >= 0 else 0
		hud.flash_battle_cry(CLOWN_BATTLE_CRIES[idx % CLOWN_BATTLE_CRIES.size()], "clown")
	elif phase == "free_roam":
		hud.flash_disperse()
	if labyrinth != null:
		labyrinth.set_phase_tint(phase)

const VersionCheck := preload("res://scripts/network/version_check.gd")

func _on_room_error(code: String, message: String) -> void:
	if code == "version_mismatch":
		Telemetry.track_connect_result("rejected", "version_mismatch")
		_show_version_mismatch_popup(message)
		return
	if code == "session_expired":
		# Reconnect grace window expired before our ladder got a session
		# token back to the server. The player's slot is gone; the match
		# may still be running. Send them back to the menu cleanly.
		Telemetry.track_connect_result("rejected", "session_expired")
		_show_rejected_popup(
			"Match ended",
			"You were disconnected for too long. Returning to the menu.",
		)
		return
	if code == "match_in_progress":
		# We tried to join a room whose phase is past 'filling' without a
		# session token. Most often hit when the matchmaker has not yet
		# reaped a now-running room from its open pool, or when a stale
		# private code is shared after the host started the match.
		Telemetry.track_connect_result("rejected", "match_in_progress")
		_show_rejected_popup(
			"Match already running",
			"This room is already mid-match. Try Find Match again for a new one.",
		)
		return
	hud.append_log("Server error %s: %s" % [code, message])

# Single popup helper for the rejected-join family (session_expired,
# match_in_progress). Stops the reconnect ladder so it does not retry
# into the same rejection, then surfaces the supplied title + body and
# routes the OK back to the menu.
func _show_rejected_popup(title: String, body: String) -> void:
	reconnect.stop()
	reconnect.hide_banner()
	var dialog := AcceptDialog.new()
	dialog.title = title
	dialog.dialog_text = body
	dialog.ok_button_text = "Back to menu"
	dialog.unresizable = true
	dialog.confirmed.connect(_on_back_to_menu)
	_attach_dialog_lifecycle(dialog)
	dialog.popup_centered()

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
	_attach_dialog_lifecycle(dialog)
	dialog.popup_centered()

# Wire any AcceptDialog so it self-cleans on any close path. Without this,
# clicking the X (close_requested) or hitting OK on a popup whose confirmed
# handler doesn't change scenes (version mismatch's Close button is the
# canonical case) leaves the dialog node in the tree forever - stacking
# multiple reconnect popups across a churny session leaks them all.
func _attach_dialog_lifecycle(dialog: AcceptDialog) -> void:
	dialog.confirmed.connect(dialog.queue_free)
	dialog.close_requested.connect(dialog.queue_free)
	add_child(dialog)

func _drive_online_hud() -> void:
	if not snapshot_received:
		return
	if reconnect.is_active():
		# While the reconnect ladder is running, the server-side tick is
		# paused (no active humans) so turnEndsAt is held in place, but
		# the local clock keeps advancing. Without this gate the visible
		# countdown would race toward zero during the disconnect and
		# snap back up when the next delta arrives. Holding the last
		# rendered value matches what the server is doing - the turn
		# clock pauses with the world.
		return
	var now_ms: float = Time.get_unix_time_from_system() * 1000.0
	var remaining_s: float = max(0.0, (turn_ends_at_ms - now_ms) / 1000.0)
	hud.set_countdown_seconds(remaining_s)
	# Feed the minimap the live body yaw so its facing arrow tracks the mouse
	# without the 10 Hz delta lag, and keeps turning while frozen (the server
	# stops applying input then, so the snapshot yaw would be stuck).
	if local_player != null:
		hud.set_local_facing_yaw(local_player.rotation.y)

# Collect XZ positions of every non-local rendered body. Used by the
# predictor's collision-resolve step so the local body bounces off
# others client-side rather than only after a server reconcile.
func _collect_other_xz_positions() -> Array:
	var result: Array = []
	for id in player_nodes:
		if id == local_player_id:
			continue
		var node: Node = player_nodes[id]
		if node == null:
			continue
		result.append(Vector2(node.global_position.x, node.global_position.z))
	return result

func _stream_input(delta: float) -> void:
	# _on_back_to_menu and the reconnect-failed popup null room_client and
	# emit a scene change. The scene swap takes one frame to land, so this
	# physics tick can fire once on a null reference if we don't guard.
	# Same shape of guard during a reconnect attempt (room_client exists
	# but the WS is not open) since send_text would fail anyway.
	if room_client == null or not room_client.is_connected_to_server():
		return
	input_accumulator += delta
	if input_accumulator < INPUT_TICK_PERIOD:
		return
	# Carry over the remainder so the average tick rate stays at 20 Hz even
	# when physics frames don't land exactly on tick boundaries.
	input_accumulator -= INPUT_TICK_PERIOD
	input_seq += 1
	# Persist back onto the connection so the next arena (Play Again) resumes
	# from here instead of restarting at 0.
	room_client.input_seq = input_seq
	# Sample WASD in player-local axes, then rotate into world XZ. Server and
	# client both treat input.move as world-space, so reconciliation replay
	# does not need to know the player's yaw at each historical tick.
	var wasd: Vector2 = _sample_move_intent()
	var yaw: float = local_player.rotation.y
	# Camera pitch rides the input so remote viewers can tilt this body's head.
	# Mouse look (including pitch) stays live while frozen, so this is always
	# the current value even when movement is gated.
	var pitch: float = local_player.camera.rotation.x if local_player.camera != null else 0.0
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
	# Rising-edge spacebar detection so holding Space sends exactly one
	# jump per press. The server's stepJump gates re-triggers on the
	# arc + cooldown lockout anyway, but debouncing here keeps the input
	# stream honest and avoids the predictor having to chew on a
	# stuck-true input every tick.
	var jump_pressed: bool = false
	if not frozen and Input.is_action_pressed("jump"):
		if not _jump_was_held:
			jump_pressed = true
		_jump_was_held = true
	else:
		_jump_was_held = false
	# Shoot is a standalone message, not part of the input frame. Rising-edge
	# on the mouse so a held button fires one shot per press; aim is the
	# camera's forward (-Z of its basis), giving full 3D pitch+yaw aim.
	if not frozen and _input_active() and Input.is_action_pressed("shoot"):
		var shot_now_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
		var off_cooldown: bool = (
			_overcharge_armed
			or shot_now_ms - _last_shot_at_ms >= int(SharedConstants.SHOOT_COOLDOWN_MS)
		)
		if not _shoot_was_held and off_cooldown and local_player.camera != null:
			var aim: Vector3 = -local_player.camera.global_transform.basis.z
			room_client.send_shoot(aim)
			_last_shot_at_ms = shot_now_ms
			_overcharge_armed = false
		_shoot_was_held = true
	else:
		_shoot_was_held = false
	# Use-item is a standalone message like shoot, on the rising edge of E so a
	# held key activates once per press. The server no-ops an empty slot.
	if not frozen and _input_active() and Input.is_action_pressed("use_item"):
		if not _use_item_was_held:
			room_client.send_use_item()
			# Arm the local leap prediction in the same frame the server arms
			# leapArmed, so the next predicted jump uses the boosted arc
			# without waiting a round-trip for the authoritative leaping flag.
			if _held_item == "leap":
				predictor.arm_leap()
			elif _held_item == "surge":
				predictor.arm_surge()
			elif _held_item == "overcharge":
				_overcharge_armed = true
		_use_item_was_held = true
	else:
		_use_item_was_held = false
	var input_now_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	pending_inputs.append({
		"seq": input_seq,
		"world_move": effective_move,
		"sprint": effective_sprint,
		"dt": INPUT_TICK_PERIOD,
		"jump": jump_pressed,
		"now_ms": input_now_ms,
	})
	# Drop the oldest un-acked input when the buffer is over budget. Only
	# happens when the server has stopped acking; the dropped frames are
	# already too stale to reconcile against, and the cap keeps replay cost
	# bounded so a stalled ack can never spiral into a crash.
	while pending_inputs.size() > MAX_PENDING_INPUTS:
		pending_inputs.pop_front()
	room_client.send_input(
		input_seq,
		INPUT_TICK_PERIOD,
		effective_move,
		yaw,
		pitch,
		sprinting,
		jump_pressed,
	)
	# Advance the authoritative predicted XZ + jumpStartedAt by exactly
	# the same input the server will apply. The render loop interpolates
	# the XZ in _advance_local_prediction and recomputes Y from the arc
	# at render rate so a >60 Hz monitor stays smooth.
	predictor.advance_tick(effective_move, effective_sprint, jump_pressed, input_now_ms)

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
	# Team can change after the node was spawned: balanceHumansForMatchStart
	# re-splits the human roster 50/50 at match start and resends the snapshot.
	# The node carries its join-time team, so adopt any change here - otherwise
	# the body keeps the wrong color and, for the local player, the "you are a
	# MIME" badge and the minimap perspective stay on the old team while the
	# server actually plays them on the new one.
	var entry_team: String = entry.get("team", node.team)
	if entry_team != node.team:
		node.team = entry_team
		node._apply_head_texture()
		if id == local_player_id:
			hud.set_local_team(entry_team)
	var pos: Dictionary = entry.get("position", {"x": 0.0, "z": 0.0})
	# Y now flows over the wire (PlayerState.position became Vec3 in
	# PR 1). For backward-compat with any frame that omits it, default
	# to HOVER_HEIGHT.
	var pos_vec := Vector3(
		float(pos.get("x", 0.0)),
		float(pos.get("y", Physics.HOVER_HEIGHT)),
		float(pos.get("z", 0.0)),
	)
	var yaw: float = float(entry.get("yaw", 0.0))
	var pitch: float = float(entry.get("pitch", 0.0))
	var is_frozen: bool = bool(entry.get("frozen", false))
	var sprint: float = float(entry.get("sprintEnergy", 100.0))
	# Server-authoritative jumpStartedAt. Drives the squash-and-stretch
	# animation. Null on the wire arrives as Variant null; convert to
	# the GDScript -1 null sentinel.
	var server_jump_started: Variant = entry.get("jumpStartedAt", null)
	var jump_started_at_ms: int = (
		int(server_jump_started) if server_jump_started != null else -1
	)
	if id == local_player_id:
		# Don't overwrite the local player's predicted position; sync the
		# server-authoritative bits that the client cannot derive on its own.
		node.frozen = is_frozen
		node.sprint_energy = sprint
		# Held power-up slot is server-authoritative: a pickup sets activeItem,
		# a use_item clears it. Empty/absent string hides the slot. Cache the
		# type so the use_item key can arm a type-specific local prediction
		# (leap) in the same frame it sends the message.
		var _prev_held := _held_item
		_held_item = String(entry.get("activeItem", ""))
		# Telemetry: a held-item slot filling from empty is a floor-item pickup
		# (a use clears it the other way, emitted on the input edge).
		if _prev_held.is_empty() and not _held_item.is_empty():
			Telemetry.track_item_pickup(_held_item)
		hud.set_held_item(_held_item)
		# Local body's jumpStartedAt comes from the predictor, not the
		# server snapshot - the predictor is one tick ahead and stays
		# in sync via the reconcile replay. Setting it here would lag
		# the squash animation behind the body's actual Y.
	else:
		node.apply_remote_state(pos_vec, yaw, pitch, is_frozen, sprint)
		node.jump_started_at_ms = jump_started_at_ms
		# Server-authoritative leap flag so the remote body's render-rate
		# arc Y uses the boosted amplitude that clears walls.
		node.leaping = bool(entry.get("leaping", false))
		# Cloak deadline: while in the future the body hides itself locally.
		node.cloak_until_ms = int(entry.get("cloakUntil", 0))

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
	# Telemetry: our shot froze someone - a successful projectile hit. Bucket by
	# our distance to the victim (the freeze is the only client-visible hit).
	if attacker_id == local_player_id and local_player != null and node != null and topology != null:
		Telemetry.track_projectile_hit(
			topology.distance(local_player.global_position, node.global_position)
		)

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
	_ended_win_team = team
	# Drop back to our own camera for the end screen if we were spectating a
	# teammate while frozen at the buzzer.
	_spectate_delay_timer.stop()
	_spectate_active = false
	stop_spectating()
	var victory: bool = local_player != null and team == local_player.team
	if local_player != null:
		Telemetry.track_match_end("won" if victory else "lost", local_player.team)
	# Allow the next match (Play Again / new round) to emit its own match_start.
	_match_telemetry_emitted = false
	# Only the private-lobby host gets Play Again; the server gates the
	# restart_room message to the host player anyway, so a non-host who
	# never sees the button can't trigger a restart. OPEN matches have no
	# host, so the button stays hidden for them too. is_room_host also covers
	# a player the server promoted mid-match after the original host left.
	var is_host: bool = online_mode and GameState.is_room_host
	# Free the cursor so the end overlay is clickable; while captured the mouse
	# only steers look yaw (player.gd gates motion on MOUSE_MODE_CAPTURED). A
	# fresh match recaptures it when the next local player spawns.
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	hud.show_end(victory, is_host)
	_play_stinger(victory)
	# Open matches have no Play Again. A party returns to its party screen after
	# the result so they can re-queue together with one Find Match; strangers
	# (not in a party) keep the normal end screen + Back to Menu.
	if online_mode and not GameState.party_id.is_empty():
		_schedule_return_to_party()

const PARTY_RETURN_DELAY_S := 3.5

func _schedule_return_to_party() -> void:
	if _returning_to_party:
		return
	_returning_to_party = true
	await get_tree().create_timer(PARTY_RETURN_DELAY_S).timeout
	if not is_inside_tree():
		return
	# Leave the finished room; the next Find Match opens a fresh connection. Mirrors
	# the teardown in _on_back_to_menu so a dead RoomClient isn't inherited.
	NetClient.close()
	room_client = null
	requested_screen.emit("party")

func _on_play_again() -> void:
	if room_client == null or not room_client.is_connected_to_server():
		return
	# Disable to swallow a double-click; the server's phase->filling
	# broadcast swaps us to the lobby a moment later.
	hud.set_play_again_enabled(false)
	room_client.send_restart_room()

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

func _build_labyrinth(seed_value: int) -> void:
	var node: Node3D = LABYRINTH.instantiate()
	labyrinth_holder.add_child(node)
	labyrinth = node
	labyrinth.build(seed_value, topology)

func _spawn_player(id: String, p_name: String, team: String, is_bot: bool, is_local: bool) -> void:
	var p: Node = PLAYER.instantiate()
	p.team = team
	p.bot = is_bot
	p.is_local = is_local
	p.display_name = p_name
	# Used by remote bodies' _to_camera_nearest_copy to render at the
	# wrap-equivalent position nearest the local camera. Local body
	# doesn't need it (its position is owned by the predictor) but
	# setting it unconditionally keeps spawn symmetric.
	p.arena = self
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
		hud.set_local_player_id(id)
		hud.set_local_team(team)

func _team_spawn_offset(team: String) -> Vector3:
	# Mimes land at cell (3, 5) center, clowns at cell (6, 5) center. Both are
	# interior cells of the 10x10 grid (cell size 8.0) so the spawn jitter
	# stays away from any wall on the cell boundary.
	if team == "mime":
		return Vector3(-12.0, 0.0, 4.0)
	return Vector3(12.0, 0.0, 4.0)

# Offline rules-event handlers + team-status render live in
# game/scripts/offline_mode.gd. The shared MIME_BATTLE_CRIES /
# CLOWN_BATTLE_CRIES constants below stay here because the online
# phase-event handler also uses them.

# ---------------------------------------------------------------------------
# HUD helpers
# ---------------------------------------------------------------------------

func _on_local_frozen_changed(is_frozen: bool) -> void:
	if is_frozen:
		# Schedule the switch to a teammate's POV after a short beat. The actual
		# pick happens on timeout (and re-validates each frame) so we never switch
		# if the player gets saved during the delay.
		_spectate_delay_timer.start()
	else:
		hud.clear_frozen_overlay()
		# Saved (or match reset): cancel any pending switch and return to our POV.
		_spectate_delay_timer.stop()
		_spectate_active = false
		stop_spectating()

func _on_spectate_delay_elapsed() -> void:
	# Only enter spectator mode if we're still frozen (not saved during the beat).
	if local_player != null and is_instance_valid(local_player) and local_player.frozen:
		_spectate_active = true

# ---------------------------------------------------------------------------
# Teammate-spectator camera (Phase 1 foundation: the camera + follow only; the
# frozen state machine, cycling, and HUD land in later phases).
# ---------------------------------------------------------------------------

## Render `target`'s first-person POV: make the spectator camera current and
## drive it to the target's eye + look. No-op if the camera or target is missing.
func spectate(target: Node) -> void:
	if target == null:
		return
	# Create the camera lazily, the first time we actually spectate. Doing it at
	# _ready (before the local player spawns) would make this the scene's default
	# current camera - Godot auto-currents the first Camera3D to enter the tree -
	# and the player would spawn looking through it instead of their own.
	if _spectator_cam == null:
		_spectator_cam = Camera3D.new()
		_spectator_cam.current = false
		world.add_child(_spectator_cam)
	_spectate_target = target
	_position_spectator_cam()
	_spectator_cam.make_current()
	if local_player != null and is_instance_valid(local_player):
		local_player.spectating = true

## Return to the local player's own camera.
func stop_spectating() -> void:
	_spectate_target = null
	if local_player != null and is_instance_valid(local_player):
		local_player.spectating = false
		if local_player.camera != null:
			local_player.camera.make_current()

func is_spectating() -> bool:
	return _spectate_target != null

# One spectator tick (called each frame while _spectate_active). Keeps the
# current target if it's still a valid teammate, otherwise switches to a random
# eligible one, or falls back to our own POV when no teammate is available
# (e.g. the whole team is frozen) - re-picking automatically when one frees up.
func _tick_spectate() -> void:
	var desired: Node = _choose_spectate_target()
	if desired != _spectate_target:
		if desired == null:
			stop_spectating()
		else:
			spectate(desired)
	if _spectate_target != null and is_instance_valid(_spectate_target):
		_position_spectator_cam()

func _choose_spectate_target() -> Node:
	if _is_eligible(_spectate_target):
		return _spectate_target
	var eligible: Array = _eligible_spectate_targets()
	if eligible.is_empty():
		return null
	return eligible[randi() % eligible.size()]

func _eligible_spectate_targets() -> Array:
	var out: Array = []
	for id in player_nodes:
		if id == local_player_id:
			continue
		var node: Node = player_nodes[id]
		if _is_eligible(node):
			out.append(node)
	return out

func _is_eligible(node: Node) -> bool:
	if node == null or not is_instance_valid(node) or node == local_player:
		return false
	var my_team: String = local_player.team if local_player != null else ""
	return Spectator.is_teammate_target(node.team, node.frozen, my_team)

func _position_spectator_cam() -> void:
	_spectator_cam.global_position = Spectator.eye_position(_spectate_target.global_position)
	_spectator_cam.rotation = Spectator.look_rotation(
		_spectate_target.rotation.y, _spectate_target.render_pitch
	)

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
	# Telemetry: leaving while a match is still live (not won) is an abandon -
	# covers menu-quit, reconnect give-up, and rejected-popup exits, which all
	# funnel here. The win path resets the flag first, so a finished match never
	# counts as abandoned. Offline sets the same flag in OfflineMode.start.
	if _match_telemetry_emitted:
		_match_telemetry_emitted = false
		Telemetry.track_match_abandoned(phase_label)
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	# The RoomClient is parented under the NetClient autoload now (so it
	# could survive the lobby -> arena scene swap). Tearing down through
	# NetClient.close() closes the socket AND frees the node; without that
	# the next match would inherit a dead RoomClient from the previous
	# session.
	NetClient.close()
	room_client = null
	requested_screen.emit("menu")

# Host hit Play Again: the server reset the room to `filling` and re-broadcast
# the lobby roster. Hand the still-open connection back to the lobby scene,
# which adopts it (see lobby.gd's NetClient.is_open() branch) instead of
# kicking off a fresh matchmaker call. We must NOT call NetClient.close() here -
# that path is for leaving the match entirely.
func _return_to_lobby() -> void:
	if returning_to_lobby:
		return
	returning_to_lobby = true
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	if reconnect != null:
		reconnect.stop()
	# Detach our own handlers before the swap so a delta landing in the same
	# frame doesn't drive a half-torn-down arena, and so the surviving
	# RoomClient has no dangling connections to this freed scene.
	_disconnect_room_handlers()
	room_client = null
	requested_screen.emit("lobby")

# Disconnect every RoomClient signal _start_online wired up. Used on the Play
# Again hand-off so the RoomClient (which outlives this scene under NetClient)
# carries no connections into the freed arena.
func _disconnect_room_handlers() -> void:
	if room_client == null:
		return
	room_client.connected.disconnect(_on_room_connected)
	room_client.disconnected.disconnect(_on_room_disconnected)
	room_client.snapshot_received.disconnect(_on_snapshot)
	room_client.delta_received.disconnect(_on_delta)
	room_client.event_received.disconnect(_on_room_event)
	room_client.error_received.disconnect(_on_room_error)

func _on_menu_resume() -> void:
	menu.close()
	# in_game_menu.close() recaptures the mouse for active play, but if the
	# match-end overlay is up (you paused on the end screen), resuming must leave
	# the cursor free so Play Again / Back to menu stay clickable.
	if hud != null and hud.is_end_showing():
		Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)

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
