extends Node

## Offline match orchestrator. Owns rules wiring, bot spawning + AI,
## event handlers, team-status rendering, seed derivation, and the
## per-frame hud drive. Extracted from arena.gd under Phase C4 of the
## file-split plan.
##
## Node (not RefCounted) because it parents the GameRulesScript instance
## and the BotAI nodes attached to each bot body; both need to live in
## the scene tree to receive _process / _physics_process.
##
## Host pattern: stores an `arena: Node` reference set at construction.
## Reads arena.topology, arena.hud, arena.labyrinth, arena.player_nodes,
## arena.local_player_id, plus delegates back to arena._build_labyrinth,
## arena._spawn_player, arena._surface_tag_reject, and arena._play_stinger.
## Writes arena.rules (kept on arena so contact_interactions.gd can read
## it without needing to know about OfflineMode) and arena.local_player_id.

const GameRulesScript := preload("res://scripts/game_rules.gd")
const BotAIScript := preload("res://scripts/bot_ai.gd")
const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")

# Per-team bot fill target. 3 bots per side gives a 4-vs-4 (with the
# local human on one side) which the playtest landed on as the right
# match size for the offline labyrinth.
const BOT_COUNT_PER_TEAM := 3

var arena: Node = null

func attach(arena_ref: Node) -> void:
	arena = arena_ref

## Boot the offline match. Builds the labyrinth, wires rules, spawns
## human + bots, kicks the rules state machine into its first phase.
func start() -> void:
	arena.topology = TopologyFactory.from_string(GameState.topology_as_string())
	arena.hud.set_topology(arena.topology.name())
	arena._build_labyrinth(_derive_seed())
	_setup_rules()
	_spawn_players()
	arena.rules.start(arena.topology)

## Called from arena._process during offline play. Pushes live positions
## to the rules engine and refreshes the countdown label.
func drive_hud() -> void:
	if arena.rules == null:
		return
	for id in arena.player_nodes.keys():
		arena.rules.update_position(id, arena.player_nodes[id].global_position)
	arena.rules.tick(Time.get_unix_time_from_system())
	arena.hud.set_countdown_seconds(arena.rules.phase_time_remaining(Time.get_unix_time_from_system()))

func _setup_rules() -> void:
	arena.rules = GameRulesScript.new()
	add_child(arena.rules)
	arena.rules.topology = arena.topology
	arena.rules.tagged.connect(_on_tagged)
	arena.rules.tag_rejected.connect(_on_tag_rejected)
	arena.rules.saved.connect(_on_saved)
	arena.rules.won.connect(_on_won)
	arena.rules.phase_changed.connect(_on_phase_changed)

func _spawn_players() -> void:
	GameState.ensure_username()
	arena.local_player_id = "local"
	arena._spawn_player(arena.local_player_id, GameState.username, "mime", false, true)
	for i in BOT_COUNT_PER_TEAM - 1:
		arena._spawn_player("mime_bot_%d" % i, UsernameGenerator.generate(), "mime", true, false)
	for i in BOT_COUNT_PER_TEAM:
		arena._spawn_player("clown_bot_%d" % i, UsernameGenerator.generate(), "clown", true, false)
	for id in arena.player_nodes.keys():
		var node: Node = arena.player_nodes[id]
		arena.rules.register_player(id, node.team, node.global_position, node.display_name, node.bot)
		if node.bot:
			_attach_bot_ai(node, id)
	_render_team_status()

func _attach_bot_ai(node: Node, id: String) -> void:
	var ai := BotAIScript.new()
	node.add_child(ai)
	ai.attach(node, id, arena.rules, arena.topology, arena.labyrinth)

# Derive the offline seed from the lobby code when one is set (so the
# host and joiners would generate the same labyrinth if offline ever
# supported peer-to-peer) and a fresh random one otherwise. The mask
# keeps it positive so the GDScript hash mismatch path doesn't trip
# negative-int corner cases in the gridMaze fixture.
func _derive_seed() -> int:
	if GameState.lobby_code.is_empty():
		return randi()
	return GameState.lobby_code.hash() & 0x7fffffff

# ---------------------------------------------------------------------------
# Rules event handlers
# ---------------------------------------------------------------------------

func _on_tagged(victim_id: String, attacker_id: String, team: String) -> void:
	var victim: Node = arena.player_nodes.get(victim_id)
	if victim != null:
		victim.frozen = true
	var attacker_info: Dictionary = arena.rules.players.get(attacker_id, {})
	var victim_info: Dictionary = arena.rules.players.get(victim_id, {})
	var verb: String = "mimed" if team == "mime" else "clowned"
	arena.hud.append_log("%s was %s by %s" % [victim_info.get("name", "?"), verb, attacker_info.get("name", "?")])
	if victim_id == arena.local_player_id:
		arena.hud.flash_frozen(team, attacker_info.get("name", "?"))
	_render_team_status()

func _on_tag_rejected(attacker_id: String, _victim_id: String, reason: String) -> void:
	# Offline mirror of the online tag_result handler. Only the local
	# player gets feedback; remote bots don't have anyone to message and
	# the verbose log would be noisy with bot misses.
	if attacker_id != arena.local_player_id:
		return
	arena._surface_tag_reject(reason)

func _on_saved(victim_id: String, savior_id: String) -> void:
	var victim: Node = arena.player_nodes.get(victim_id)
	if victim != null:
		victim.frozen = false
	var savior_info: Dictionary = arena.rules.players.get(savior_id, {})
	var victim_info: Dictionary = arena.rules.players.get(victim_id, {})
	arena.hud.append_log("%s saved %s" % [savior_info.get("name", "?"), victim_info.get("name", "?")])
	if victim_id == arena.local_player_id:
		arena.hud.clear_frozen_overlay()
	_render_team_status()

func _on_won(team: String) -> void:
	var victory: bool = team == arena.local_player.team
	arena.hud.show_end(victory)
	arena._play_stinger(victory)

func _on_phase_changed(phase: int) -> void:
	# Match the online phase handler's MIME_/CLOWN_BATTLE_CRIES tables.
	# Arena owns the constants because the online phase handler also
	# uses them; reading through `arena.MIME_BATTLE_CRIES` keeps a single
	# source of truth.
	match phase:
		GameRulesScript.Phase.FREE_ROAM:
			arena.hud.flash_disperse()
		GameRulesScript.Phase.TURN_MIME:
			arena.hud.flash_battle_cry(arena.MIME_BATTLE_CRIES[randi() % arena.MIME_BATTLE_CRIES.size()], "mime")
		GameRulesScript.Phase.TURN_CLOWN:
			arena.hud.flash_battle_cry(arena.CLOWN_BATTLE_CRIES[randi() % arena.CLOWN_BATTLE_CRIES.size()], "clown")

func _render_team_status() -> void:
	var list: Array = []
	for player in arena.rules.players.values():
		list.append(player)
	arena.hud.render_team_status(list)
