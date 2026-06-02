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
const OfflineItemsScript := preload("res://scripts/offline_items.gd")
const ItemRendererScript := preload("res://scripts/item_renderer.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")
const OfflineProjectilesScript := preload("res://scripts/offline_projectiles.gd")
const ProjectileRendererScript := preload("res://scripts/projectile_renderer.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")
const OfflinePortalsScript := preload("res://scripts/offline_portals.gd")
const PortalRendererScript := preload("res://scripts/portal_renderer.gd")

# Per-team bot fill target. 3 bots per side gives a 4-vs-4 (with the
# local human on one side) which the playtest landed on as the right
# match size for the offline labyrinth.
const BOT_COUNT_PER_TEAM := 3

var arena: Node = null
# Offline power-up system + its floor renderer (online builds the renderer on
# the network path; offline owns both here).
var _items: OfflineItemsScript = null
# Live offline projectiles + per-shooter cooldown clock + id counter.
var _projectiles: Array = []
var _last_shot_ms: Dictionary = {}
var _proj_seq: int = 0
# Live portal pairs + per-player blocked/cooldown state + exit-wall rng.
var _portals: Array = []
var _portal_blocked: Dictionary = {}
var _portal_cooldown: Dictionary = {}
var _portal_seq: int = 0
var _portal_rng := RandomNumberGenerator.new()

func attach(arena_ref: Node) -> void:
	arena = arena_ref

## Boot the offline match. Builds the labyrinth, wires rules, spawns
## human + bots, kicks the rules state machine into its first phase.
func start() -> void:
	arena.topology = TopologyFactory.from_string(GameState.topology_as_string())
	arena.hud.set_topology(arena.topology.name())
	var seed_value := _derive_seed()
	arena._build_labyrinth(seed_value)
	_setup_rules()
	# Give the rules the maze walls so tag / unfreeze honor line-of-sight.
	arena.rules.walls = arena.labyrinth.wall_endpoints() if arena.labyrinth != null else []
	_spawn_players()
	# Same seed as the maze so the item layout matches what the server would
	# spawn for this room (the shared deterministic layout).
	_items = OfflineItemsScript.new()
	# Clone is disabled offline: a clone is itself an item-using bot, so clones
	# spawn clones and the body + AI-node count snowballs into frame lag. Drop it
	# from the floor entirely (rather than spawn a dud) so it never confuses.
	_items.spawn(seed_value, arena.topology.name(), ["clone"])
	if arena.item_renderer == null:
		arena.item_renderer = ItemRendererScript.new(arena)
	arena.item_renderer.render_from_snapshot(_item_wire())
	if arena.projectile_renderer == null:
		arena.projectile_renderer = ProjectileRendererScript.new(arena)
	if arena.portal_renderer == null:
		arena.portal_renderer = PortalRendererScript.new(arena)
	_portal_rng.randomize()
	# Offline can shoot now, so show the aiming crosshair like the online path.
	arena.hud.set_crosshair_visible(true)
	arena.rules.start(arena.topology)

## Called from arena._process during offline play. Pushes live positions
## to the rules engine, runs the item pickup/respawn pass, and refreshes the
## countdown label + floor item icons.
func drive_hud(delta: float) -> void:
	if arena.rules == null:
		return
	for id in arena.player_nodes.keys():
		# Bodies render at a camera-nearest seam copy; feed the rules engine the
		# canonical position so tags, perception, and the minimap stay correct.
		var pos: Vector3 = arena.player_nodes[id].global_position
		arena.rules.update_position(id, arena.topology.wrap(pos) if arena.topology != null else pos)
	arena.rules.tick(Time.get_unix_time_from_system())
	_step_items(delta)
	_step_projectiles(delta)
	_step_portals(delta)
	arena.hud.set_countdown_seconds(arena.rules.phase_time_remaining(Time.get_unix_time_from_system()))
	# The minimap plots live positions, so refresh it every frame here rather
	# than only on tag/save events (which sufficed for the old status bars).
	_render_team_status()

# Respawn + pickup pass, then reconcile the floor icons. A local pickup fills
# the held-item HUD slot. Effects on use land in a follow-up.
func _step_items(delta: float) -> void:
	if _items == null:
		return
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	var events: Array = _items.step(now_ms, arena.rules.players.values(), arena.topology)
	for ev in events:
		if ev.player_id == arena.local_player_id:
			var held: String = arena.rules.players[ev.player_id].get("active_item", "")
			arena.hud.set_held_item(held)
	if arena.item_renderer != null:
		arena.item_renderer.render_from_snapshot(_item_wire())
		arena.item_renderer.tick(delta)

# The local player used their held item (rising edge of E). Clear the slot and
# apply the effect.
func use_item_local() -> void:
	if _items == null:
		return
	var id: String = arena.local_player_id
	var p: Dictionary = arena.rules.players.get(id, {})
	if p.is_empty():
		return
	var item_type: String = _items.use_item(p)
	if item_type == "":
		return
	arena.hud.set_held_item("")
	_apply_item_effect(arena.local_player, item_type, id)

# A bot used its held item (decided by its AI). Clear the slot + apply the effect
# to its body, keyed by its id. Returns the used type ("" if it held nothing).
# Mirrors the server's useBotItem.
func bot_use_item(player_id: String, node: Node) -> String:
	if _items == null or node == null:
		return ""
	var p: Dictionary = arena.rules.players.get(player_id, {})
	if p.is_empty():
		return ""
	var item_type: String = _items.use_item(p)
	if item_type == "":
		return ""
	_apply_item_effect(node, item_type, player_id)
	return item_type

# Per-type effect on the given player's body, keyed by player_id for the effects
# that live on the rules dict (radar / overcharge) or per-player portal block.
func _apply_item_effect(node: Node, item_type: String, player_id: String) -> void:
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	match item_type:
		"cloak":
			node.cloak_until_ms = now_ms + OfflineItemsScript.CLOAK_DURATION_MS
		"leap":
			node.leap_armed = true
		"surge":
			node.surge_until_ms = now_ms + int(SharedConstants.SURGE_DURATION_MS)
		"radar":
			# The minimap reveals the enemy team while radarUntil is in the
			# future; it reads that key off the rules dict. (For a bot the reveal
			# is inert - its AI seeds investigate memory from the use decision.)
			var p: Dictionary = arena.rules.players.get(player_id, {})
			if not p.is_empty():
				p["radarUntil"] = now_ms + OfflineItemsScript.RADAR_DURATION_MS
		"overcharge":
			# Arm the next shot (read in _shoot off the rules dict): it pierces
			# and skips the cooldown.
			var p2: Dictionary = arena.rules.players.get(player_id, {})
			if not p2.is_empty():
				p2["overchargeArmed"] = true
		"portal":
			_open_portal(node, player_id)

# Open a portal pair for the opener (entry mouth on the wall they face, exit on
# a random other wall) and block them from it until they step clear. Mirrors
# itemManager.openPortal.
func _open_portal(owner: Node, player_id: String) -> void:
	var walls: Array = arena.labyrinth.wall_endpoints() if arena.labyrinth != null else []
	if walls.is_empty():
		return
	var geom: Dictionary = OfflinePortalsScript.build_portal_pair(
		owner.global_position.x, owner.global_position.z, owner.rotation.y, walls, arena.topology, _portal_rng.randf
	)
	if geom.is_empty():
		return
	_portal_seq += 1
	geom["id"] = "portal_%d" % _portal_seq
	geom["owner"] = player_id
	geom["expires_at"] = (
		int(Time.get_unix_time_from_system() * 1000.0) + OfflinePortalsScript.PORTAL_DURATION_MS
	)
	_portals.append(geom)
	# The opener stands on the entry mouth; block them until they step clear so
	# the pair doesn't instantly teleport them off it.
	_portal_blocked[player_id] = true

# Entry (a) + exit (b) mouths of the live portal `player_id` opened, or null.
# A fleeing bot heads into its own entry mouth via BotGoals.portal_escape_target.
# Mirrors the server's botPortalEntry.
func bot_portal_entry(player_id: String) -> Variant:
	for portal in _portals:
		if portal.get("owner", "") == player_id:
			return {"a": portal.a, "b": portal.b}
	return null

# Expire elapsed pairs, then teleport any player standing on a live mouth to the
# opposite exit. Blocked-until-clear + per-player cooldown stop the bounce.
# Mirrors itemManager.stepPortals.
func _step_portals(delta: float) -> void:
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	var survivors: Array = []
	for portal in _portals:
		if portal.expires_at <= now_ms:
			if arena.portal_renderer != null:
				arena.portal_renderer.on_close(portal.id)
		else:
			survivors.append(portal)
	_portals = survivors
	if _portals.is_empty():
		_portal_blocked.clear()
		_portal_cooldown.clear()
		if arena.portal_renderer != null:
			arena.portal_renderer.render_from_snapshot([])
		return
	for pid in arena.player_nodes:
		var node: Node = arena.player_nodes[pid]
		var dest = null
		var dest_yaw := 0.0
		for portal in _portals:
			if arena.topology.distance(node.global_position, portal.a) <= OfflinePortalsScript.PORTAL_ENTER_RADIUS:
				dest = portal.b_exit
				dest_yaw = portal.b_exit_yaw
				break
			if arena.topology.distance(node.global_position, portal.b) <= OfflinePortalsScript.PORTAL_ENTER_RADIUS:
				dest = portal.a_exit
				dest_yaw = portal.a_exit_yaw
				break
		if dest == null:
			_portal_blocked.erase(pid)
			continue
		if _portal_blocked.has(pid):
			continue
		if now_ms < int(_portal_cooldown.get(pid, 0)):
			continue
		node.global_position = Vector3(dest.x, node.global_position.y, dest.z)
		node.rotation.y = dest_yaw
		_portal_blocked[pid] = true
		_portal_cooldown[pid] = now_ms + OfflinePortalsScript.PORTAL_TELEPORT_COOLDOWN_MS
	if arena.portal_renderer != null:
		arena.portal_renderer.render_from_snapshot(_portal_wire())
		arena.portal_renderer.tick(delta)

# Live pairs in the {id, a:{x,y,z}, b:{x,y,z}} wire shape the renderer reads.
func _portal_wire() -> Array:
	var out: Array = []
	for portal in _portals:
		var a: Vector3 = portal.a
		var b: Vector3 = portal.b
		out.append(
			{"id": portal.id, "a": {"x": a.x, "y": a.y, "z": a.z}, "b": {"x": b.x, "y": b.y, "z": b.z}}
		)
	return out

# The local player fired (rising edge of the shoot button). Same gating as the
# server: not frozen, only on the shooter's turn, and off cooldown (unless
# overcharge - wired with the overcharge effect later). `dir` is the camera
# forward ray. Returns whether a projectile launched.
func shoot_local(dir: Vector3) -> bool:
	return _shoot(arena.local_player_id, dir)

# Fire on a bot's behalf (its AI decided to shoot). Same gating as the local
# shot; aim jitter is applied by the caller.
func bot_shoot(shooter_id: String, dir: Vector3) -> bool:
	return _shoot(shooter_id, dir)

func _shoot(shooter_id: String, dir: Vector3) -> bool:
	var p: Dictionary = arena.rules.players.get(shooter_id, {})
	if p.is_empty() or p.get("frozen", false):
		return false
	if arena.rules.active_team() != p.team:
		return false
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	var overcharged: bool = p.get("overchargeArmed", false)
	var last: int = _last_shot_ms.get(shooter_id, -1)
	if not overcharged and last >= 0 and now_ms - last < OfflineProjectilesScript.SHOOT_COOLDOWN_MS:
		return false
	var owner := {"id": shooter_id, "team": p.team, "position": p.position}
	_proj_seq += 1
	var proj: Dictionary = OfflineProjectilesScript.spawn_projectile(
		owner, dir, "p-%d" % _proj_seq, now_ms, now_ms
	)
	if proj.is_empty():
		return false
	if overcharged:
		# Overcharge: this shot pierces walls and skips the cooldown gate.
		proj.piercing = true
		p.erase("overchargeArmed")
	_last_shot_ms[shooter_id] = now_ms
	_projectiles.append(proj)
	return true

# Advance projectiles, freeze any victims, and reconcile the rendered spheres.
func _step_projectiles(delta: float) -> void:
	if _projectiles.is_empty():
		if arena.projectile_renderer != null:
			arena.projectile_renderer.render_from_delta([])
		return
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0)
	var targets: Array = []
	for pid in arena.rules.players:
		var pp: Dictionary = arena.rules.players[pid]
		targets.append(
			{"id": pid, "team": pp.team, "position": pp.position, "frozen": pp.get("frozen", false)}
		)
	var walls: Array = arena.labyrinth.wall_endpoints() if arena.labyrinth != null else []
	var res: Dictionary = OfflineProjectilesScript.step_projectiles(
		_projectiles,
		targets,
		{
			"dt": delta,
			"now_ms": now_ms,
			"walls": walls,
			"topology": arena.topology,
			"hit_radius": OfflineProjectilesScript.PROJECTILE_HIT_RADIUS,
			# Honor the re-tag grace so a just-saved ally is briefly projectile-
			# immune too, matching the server.
			"saved_at": arena.rules.saved_at,
			"unfreeze_grace_ms": GameRulesScript.UNFREEZE_GRACE_MS,
		}
	)
	_projectiles = res.survivors
	for hit in res.hits:
		if hit.has("victim_id"):
			arena.rules.freeze_by_projectile(hit.victim_id, hit.owner_id)
	if arena.projectile_renderer != null:
		arena.projectile_renderer.render_from_delta(_projectile_wire())
		arena.projectile_renderer.tick(delta)

# Live projectiles in the {id, team, position:{x,y,z}, velocity:{x,y,z}} wire
# shape the renderer reads.
func _projectile_wire() -> Array:
	var out: Array = []
	for proj in _projectiles:
		var pos: Vector3 = proj.position
		var vel: Vector3 = proj.velocity
		out.append(
			{
				"id": proj.id,
				"team": proj.team,
				"position": {"x": pos.x, "y": pos.y, "z": pos.z},
				"velocity": {"x": vel.x, "y": vel.y, "z": vel.z},
			}
		)
	return out

# Available (un-held, un-elapsed) floor items the bot brain seeks toward, as the
# offline_items gameplay dicts (position is a Vector3). Mirrors the server's
# host.availableItems(). Empty before the item system spawns.
func available_items() -> Array:
	return _items.available() if _items != null else []

# Floor items in the {id, type, position:{x,y,z}} wire shape the renderer reads
# (offline_items keeps positions as Vector3 for the gameplay side).
func _item_wire() -> Array:
	var out: Array = []
	for it in _items.available():
		var p: Vector3 = it.position
		out.append({"id": it.id, "type": it.type, "position": {"x": p.x, "y": p.y, "z": p.z}})
	return out

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
	var phase_name := "free_roam"
	match phase:
		GameRulesScript.Phase.FREE_ROAM:
			arena.hud.flash_disperse()
		GameRulesScript.Phase.TURN_MIME:
			phase_name = "turn_mime"
			arena.hud.flash_battle_cry(arena.MIME_BATTLE_CRIES[randi() % arena.MIME_BATTLE_CRIES.size()], "mime")
		GameRulesScript.Phase.TURN_CLOWN:
			phase_name = "turn_clown"
			arena.hud.flash_battle_cry(arena.CLOWN_BATTLE_CRIES[randi() % arena.CLOWN_BATTLE_CRIES.size()], "clown")
	if arena.labyrinth != null:
		arena.labyrinth.set_phase_tint(phase_name)

func _render_team_status() -> void:
	var list: Array = []
	for id in arena.rules.players:
		var row: Dictionary = arena.rules.players[id].duplicate()
		var node: Node = arena.player_nodes.get(id)
		if node != null:
			row["yaw"] = node.rotation.y
		list.append(row)
	arena.hud.render_team_status(list)
