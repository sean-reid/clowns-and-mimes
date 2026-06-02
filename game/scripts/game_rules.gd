extends Node

## Authoritative game rules for offline/bot mode. In a networked game the room
## drives the same state machine on the server and this node only mirrors what
## the server says. The two implementations share the same phase ordering,
## turn cadence, and tag/unfreeze validation so behavior is consistent.

const TopologyScript := preload("res://scripts/topology/topology.gd")
const PhysicsScript := preload("res://scripts/physics.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")

enum Phase { LOBBY, FREE_ROAM, TURN_MIME, TURN_CLOWN, ENDED }

const FREE_ROAM_S := 30.0
const FIRST_TURN_S := 30.0
const TURN_STEP_S := 30.0
const TURN_CAP_S := 300.0
const TAG_RADIUS := 1.4
const UNFREEZE_RADIUS := 1.4
# Re-tag grace after a save: a just-unfrozen player can't be re-tagged for this
# long. Mirrors room.ts UNFREEZE_GRACE_MS.
const UNFREEZE_GRACE_MS := 1500.0

signal phase_changed(phase: int)
signal tagged(victim_id: String, attacker_id: String, team: String)
signal tag_rejected(attacker_id: String, victim_id: String, reason: String)
signal saved(victim_id: String, savior_id: String)
signal won(team: String)

var phase: int = Phase.LOBBY
var phase_ends_at: float = 0.0
var round_number: int = 0
var first_team: String = "mime"
var topology: TopologyScript
var players: Dictionary = {}
# Maze wall segments for the tag/unfreeze line-of-sight check. Set by
# offline_mode after the labyrinth is built; empty disables the check.
var walls: Array = []
# player_id -> wall-clock ms when last unfrozen, for the re-tag grace window.
# Also fed to the projectile sim so a just-saved ally is briefly immune there
# too. Mirrors the server's lastSavedAt map.
var saved_at: Dictionary = {}

func register_player(id: String, team: String, position: Vector3, p_name: String, is_bot: bool) -> void:
	players[id] = {
		"id": id,
		"team": team,
		"position": position,
		"name": p_name,
		"frozen": false,
		"bot": is_bot,
	}

func remove_player(id: String) -> void:
	players.erase(id)
	saved_at.erase(id)

func update_position(id: String, position: Vector3) -> void:
	if not players.has(id):
		return
	players[id]["position"] = position

func start(top: TopologyScript) -> void:
	topology = top
	round_number = 0
	first_team = "mime" if randi() % 2 == 0 else "clown"
	_set_phase(Phase.FREE_ROAM, FREE_ROAM_S)

func tick(now_s: float) -> void:
	if phase == Phase.LOBBY or phase == Phase.ENDED:
		return
	if now_s < phase_ends_at:
		return
	match phase:
		Phase.FREE_ROAM:
			_begin_next_turn()
		Phase.TURN_MIME, Phase.TURN_CLOWN:
			_begin_next_turn()

func try_tag(attacker_id: String, victim_id: String) -> bool:
	if not players.has(attacker_id) or not players.has(victim_id):
		return false
	var attacker: Dictionary = players[attacker_id]
	var victim: Dictionary = players[victim_id]
	var reason: String = _tag_rejection_reason(attacker, victim)
	if reason != "":
		# Only surface the vertical-separation miss; the other rejections
		# (same team, frozen attacker, wrong turn, out of range) are either
		# silent on the server too or get noticed via gameplay feedback.
		# This keeps offline parity with the server's tag_result event
		# path: arena.gd handles `tag_rejected(_, _, 'vertical_separation')`
		# the same way it handles the online tag_result.reason.
		if reason == "vertical_separation":
			tag_rejected.emit(attacker_id, victim_id, reason)
		return false
	victim["frozen"] = true
	tagged.emit(victim_id, attacker_id, attacker["team"])
	_check_win()
	return true

func try_unfreeze(savior_id: String, victim_id: String) -> bool:
	if not players.has(savior_id) or not players.has(victim_id):
		return false
	var savior: Dictionary = players[savior_id]
	var victim: Dictionary = players[victim_id]
	if savior["team"] != victim["team"]:
		return false
	if not victim["frozen"]:
		return false
	if savior["frozen"]:
		return false
	if _distance(savior["position"], victim["position"]) > UNFREEZE_RADIUS:
		return false
	if _wall_between(savior["position"], victim["position"]):
		return false
	victim["frozen"] = false
	# Start the re-tag grace so an opponent can't instantly re-freeze the ally.
	saved_at[victim_id] = Time.get_unix_time_from_system() * 1000.0
	saved.emit(victim_id, savior_id)
	return true

# Freeze a victim hit by a projectile. The projectile sim already validated the
# hit (team / frozen / grace), so this skips the touch-tag range/turn checks and
# goes straight to the freeze + tagged + win path, mirroring the server.
func freeze_by_projectile(victim_id: String, attacker_id: String) -> void:
	if not players.has(victim_id):
		return
	var victim: Dictionary = players[victim_id]
	if victim["frozen"]:
		return
	victim["frozen"] = true
	var team: String = players[attacker_id]["team"] if players.has(attacker_id) else ""
	tagged.emit(victim_id, attacker_id, team)
	_check_win()

func phase_time_remaining(now_s: float) -> float:
	return max(0.0, phase_ends_at - now_s)

func active_team() -> String:
	if phase == Phase.TURN_MIME:
		return "mime"
	if phase == Phase.TURN_CLOWN:
		return "clown"
	return ""

func _can_tag(attacker: Dictionary, victim: Dictionary) -> bool:
	return _tag_rejection_reason(attacker, victim) == ""

# Returns the specific rejection reason for diagnostic surfacing, or ""
# when the tag is allowed. Mirrors the server's tagRejectionReason path
# in backend/room/src/room.ts so offline parity is structural, not just
# behavioural.
func _tag_rejection_reason(attacker: Dictionary, victim: Dictionary) -> String:
	if attacker["team"] == victim["team"]:
		return "same_team"
	if attacker["frozen"] or victim["frozen"]:
		return "frozen_participant"
	if active_team() != attacker["team"]:
		return "wrong_turn"
	if _in_save_grace(victim["id"]):
		return "just_saved"
	if _distance(attacker["position"], victim["position"]) > TAG_RADIUS:
		return "out_of_range"
	var a_pos: Vector3 = attacker["position"]
	var v_pos: Vector3 = victim["position"]
	if _wall_between(a_pos, v_pos):
		return "wall_in_way"
	if not PhysicsScript.vertically_overlapping(a_pos.y, v_pos.y):
		return "vertical_separation"
	return ""

# True while a just-unfrozen victim is still inside the re-tag grace window.
func _in_save_grace(victim_id: String) -> bool:
	if not saved_at.has(victim_id):
		return false
	return Time.get_unix_time_from_system() * 1000.0 - float(saved_at[victim_id]) < UNFREEZE_GRACE_MS

# True if a maze wall crosses the straight line between two bodies, so a tag /
# unfreeze can't reach through it. Mirrors the server's wall_in_way check.
func _wall_between(a: Vector3, b: Vector3) -> bool:
	return not walls.is_empty() and WallGeometry.path_crosses_wall(walls, a.x, a.z, b.x, b.z)

func _distance(a: Vector3, b: Vector3) -> float:
	if topology == null:
		return Vector2(a.x - b.x, a.z - b.z).length()
	return topology.distance(a, b)

func _begin_next_turn() -> void:
	round_number += 1
	var next_team: String
	if phase == Phase.FREE_ROAM:
		next_team = first_team
	elif phase == Phase.TURN_MIME:
		next_team = "clown"
	else:
		next_team = "mime"
	var duration: float = minf(TURN_CAP_S, FIRST_TURN_S + float(round_number - 1) * TURN_STEP_S)
	var next_phase: int = Phase.TURN_MIME if next_team == "mime" else Phase.TURN_CLOWN
	_set_phase(next_phase, duration)

func _set_phase(new_phase: int, duration_s: float) -> void:
	phase = new_phase
	phase_ends_at = Time.get_unix_time_from_system() + duration_s
	phase_changed.emit(phase)

func _check_win() -> void:
	var mimes_active := 0
	var clowns_active := 0
	for player in players.values():
		if player["frozen"]:
			continue
		if player["team"] == "mime":
			mimes_active += 1
		else:
			clowns_active += 1
	if mimes_active == 0:
		phase = Phase.ENDED
		won.emit("clown")
	elif clowns_active == 0:
		phase = Phase.ENDED
		won.emit("mime")
