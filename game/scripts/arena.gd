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
const INPUT_TICK_HZ := 20.0
const INPUT_TICK_PERIOD := 1.0 / INPUT_TICK_HZ

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

# Shared.
var local_player: Node = null
var local_player_id: String = ""
var player_nodes: Dictionary = {}
var contact_cooldowns: Dictionary = {}
# Temporary diagnostic: throttles per-target console prints when a contact
# happens but no tag/unfreeze fires. Drop together with _debug_tag_result
# once the chase-tag flow is verified.
var _debug_no_fire_throttle: Dictionary = {}

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
		# Run local prediction at the render rate (variable, often higher
		# than the 60 Hz physics tick). The body is repositioned directly
		# from the predictor each frame, so motion is as smooth as the
		# display can present. Wall collision is enforced by the same
		# stepMovement math the server runs - move_and_slide is only along
		# for gravity on the predicted-externally branch.
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
	room_client.send_join(GameState.username)

func _on_room_disconnected(reason: String) -> void:
	hud.append_log("Disconnected: %s" % reason)
	await get_tree().create_timer(1.5).timeout
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
			local_player.global_position = Vector3(
				float(pos.get("x", 0.0)),
				local_player.global_position.y,
				float(pos.get("z", 0.0)),
			)
			local_sprint_energy = float(entry.get("sprintEnergy", 100.0))
			local_sprinting = bool(entry.get("sprinting", false))
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
	# usually within a few cm of the local prediction. Snap straight to it;
	# the next physics frame extrapolates forward from there at the screen
	# rate.
	local_player.global_position = Vector3(
		replayed_pos.x, local_player.global_position.y, replayed_pos.y
	)

func _on_room_event(event: Dictionary) -> void:
	match event.get("kind", event.get("t", "")):
		"tagged": _handle_tagged(event)
		"saved": _handle_saved(event)
		"win": _handle_win(event)
		"phase": _handle_phase_event(event.get("phase", ""), int(event.get("cryIndex", -1)))
		"tag_result": _debug_tag_result(event)
		"unfreeze_result": _debug_unfreeze_result(event)

# Temporary diagnostic: print server rejections to the local Godot console
# so playtest-dev sessions can see why tags fail without flooding the HUD.
func _debug_tag_result(event: Dictionary) -> void:
	if bool(event.get("ok", false)):
		return
	print("[tag-rejected] reason=", event.get("reason", "?"), " target=", event.get("targetId", "?"))

func _debug_unfreeze_result(event: Dictionary) -> void:
	if bool(event.get("ok", false)):
		return
	print("[unfreeze-rejected] reason=", event.get("reason", "?"), " target=", event.get("targetId", "?"))

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
	else:
		hud.append_log("Phase: %s" % phase)

func _on_room_error(code: String, message: String) -> void:
	hud.append_log("Server error %s: %s" % [code, message])

func _drive_online_hud() -> void:
	if not snapshot_received:
		return
	var now_ms: float = Time.get_unix_time_from_system() * 1000.0
	var remaining_s: float = max(0.0, (turn_ends_at_ms - now_ms) / 1000.0)
	hud.set_countdown_seconds(remaining_s)

## Run one physics-frame step of the same movement math the server runs,
## scaled by the actual frame delta. Updates local_player.global_position so
## the body responds at the screen's refresh rate. The 20 Hz buffer for the
## server is still produced in _stream_input; only the rendered position
## comes from this loop.
func _advance_local_prediction(delta: float) -> void:
	if local_player == null or labyrinth == null or topology == null:
		return
	var wasd: Vector2 = _sample_move_intent()
	var yaw: float = local_player.rotation.y
	var world_move: Vector2 = _rotate_wasd_to_world(wasd, yaw)
	var sprint_held: bool = (
		Input.is_action_pressed("sprint") and _input_active() and wasd.length() > 0.0
	)
	var pos2: Vector2 = Vector2(local_player.global_position.x, local_player.global_position.z)
	var step := Movement.step(
		{
			"position": pos2,
			"sprint_energy": local_sprint_energy,
			"sprinting": local_sprinting,
		},
		{"move": world_move, "sprint": sprint_held, "dt": delta},
		labyrinth.wall_endpoints(),
		topology,
	)
	var new_pos: Vector2 = step["position"]
	local_sprint_energy = step["sprint_energy"]
	local_sprinting = bool(step["sprinting"])
	local_player.global_position = Vector3(new_pos.x, local_player.global_position.y, new_pos.y)
	var planar: float = (new_pos - pos2).length() / max(delta, 1e-4)
	# Pass the latched sprinting state, not just the held key, so the body's
	# footstep audio matches the resolved hysteresis (no audible flicker
	# when energy is below the engage threshold).
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
		var fired: bool = _attempt_interaction(id, node, active)
		if fired:
			contact_cooldowns[id] = now
		else:
			# Diagnostic: contact close enough but no tag/unfreeze fired. Throttled
			# to one log per 2 s per target so a long chase doesn't flood the
			# console. Drop with the other _debug_* helpers once the chase-tag
			# flow is verified.
			var last: float = float(_debug_no_fire_throttle.get(id, 0.0))
			if now - last > 2.0:
				_debug_no_fire_throttle[id] = now
				print(
					"[contact-no-fire] phase=", phase_label,
					" active=", active,
					" my_team=", local_player.team,
					" their_team=", node.team,
					" their_frozen=", node.frozen,
					" dist=%.2f" % dist,
				)

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
			hud.append_log("Free roam begins.")
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
		"klein": return GameState.Topology.KLEIN
		"sphere": return GameState.Topology.SPHERE
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
