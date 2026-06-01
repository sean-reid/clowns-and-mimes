extends Control

## Bottom-right minimap + tally strip. Replaces the old team-status bar.
##
## The map (top, square) plots each teammate as a dot in their team color
## (grey when frozen); the local dot is brighter with a halo + facing
## triangle. Enemies are hidden unless the local player has Radar active,
## then they appear in their own team color too. The tally strip (below) shows one dot per
## player on the field, both teams, local team on the left - the surviving
## "who's still standing" affordance from the old bars.
##
## Fed once per delta via update_state(); positions lerp toward their targets
## in _process so the 10 Hz delta cadence doesn't stutter the dots. The lerp is
## seam-aware (see _smooth_axis): on axes the topology wraps, a dot crossing the
## seam hops the short way off one edge and back on the opposite one rather than
## racing across the whole map.

const TopologyFactory := preload("res://scripts/topology/topology_factory.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")
const Hud := preload("res://scripts/hud.gd")

# Team palette is owned by hud.gd (this widget lives inside the HUD); reuse it
# rather than keep a second copy that can drift. FROZEN_COLOR is map-specific:
# the HUD greys frozen players via alpha, but a dot needs an opaque fill.
const FROZEN_COLOR := Color(0.55, 0.55, 0.58)
const MAP_BG := Color(0, 0, 0, 0.55)
const MAP_BORDER := Color(0.6, 0.6, 0.65, 0.6)
# Mobius/Klein store their playfield as a double cover: two z-mirrored copies of
# the surface, identified by (x,z) ~ (x+L, -z). The minimap folds that cover onto
# a single copy in the local viewer's frame, so a player on the copy opposite the
# viewer lands on its mirror partner (z-flipped) and renders dimmed - the cue that
# they're on the unseen side of the surface. Crossing the fold then reads as a dot
# hopping the map edge with its facing mirrored, which is the topology's seam.
# FAR_SIDE_ALPHA is that dimming.
const FAR_SIDE_ALPHA := 0.35

const TALLY_HEIGHT := 14.0
const TALLY_GAP := 6.0
const TALLY_DOT_RADIUS := 3.0
const TALLY_DOT_SPACING := 9.0
const DOT_RADIUS := 3.0
const LOCAL_DOT_RADIUS := 5.0
const LERP_RATE := 12.0

# Wall-clock smoothing target normalized into [0,1]^2, keyed by player id.
var _display: Dictionary = {}
# Per-player render rows built in update_state: each is
# {id, team, frozen, is_local, is_enemy, target: Vector2, yaw}.
var _rows: Array = []
var _topology_name: String = ""
var _topology = null
# Id of the local viewer, kept so _draw can work out which double-cover copy
# the viewer is on and fade the dots sitting on the opposite copy.
var _local_id: String = ""
# Live body yaw of the local player, pushed every render frame by the arena.
# The local facing arrow uses this instead of the snapshot yaw so it tracks
# the mouse with zero lag - and keeps moving while frozen, where the server
# stops applying input and the snapshot yaw would otherwise be stuck.
var _local_live_yaw: float = 0.0
var _has_live_yaw: bool = false

## Normalized [0,1]^2 projection of a world XZ position for the given topology
## adapter. Static so it can be unit-tested without a scene tree. The full
## playfield span on each axis is extent_x()/extent_z(); centered domains map
## the negative half-extent to 0 and the positive to 1.
static func project_normalized(pos: Vector3, topology) -> Vector2:
	var ex: float = topology.extent_x()
	var ez: float = topology.extent_z()
	var u: float = clampf((pos.x + ex * 0.5) / ex, 0.0, 1.0)
	var v: float = clampf((pos.z + ez * 0.5) / ez, 0.0, 1.0)
	return Vector2(u, v)

static func _to_vec3(value) -> Vector3:
	if value is Vector3:
		return value
	if value is Dictionary:
		return Vector3(value.get("x", 0.0), value.get("y", 0.0), value.get("z", 0.0))
	return Vector3.ZERO

## Rebuild the render rows from the latest snapshot. `players` is the same
## array the old render_team_status received (online deltas or offline rules
## dicts); local_id/local_team identify the viewer; topology_name selects the
## projection. Enemies are only included when the local player's Radar is live.
func update_state(players: Array, local_id: String, local_team: String, topology_name: String) -> void:
	_local_id = local_id
	if topology_name != _topology_name or _topology == null:
		_topology_name = topology_name
		_topology = TopologyFactory.from_string(topology_name) if not topology_name.is_empty() else null
	var now_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	var radar_active := false
	for p in players:
		if String(p.get("id", "")) == local_id:
			radar_active = int(p.get("radarUntil", 0)) > now_ms
			break
	_rows.clear()
	var seen: Dictionary = {}
	for p in players:
		var id := String(p.get("id", ""))
		if id.is_empty():
			continue
		seen[id] = true
		var team := String(p.get("team", "mime"))
		var is_enemy := team != local_team
		var target := Vector2(0.5, 0.5)
		if _topology != null:
			target = project_normalized(_to_vec3(p.get("position", Vector3.ZERO)), _topology)
		_rows.append({
			"id": id,
			"team": team,
			"frozen": bool(p.get("frozen", false)),
			"is_local": id == local_id,
			"is_enemy": is_enemy,
			"radar": radar_active,
			"target": target,
			"yaw": float(p.get("yaw", 0.0)),
		})
	# Drop smoothing state for players who left so _display can't grow forever.
	for id in _display.keys():
		if not seen.has(id):
			_display.erase(id)
	queue_redraw()

## Live body yaw of the local player, pushed every render frame by the arena so
## the local facing arrow tracks the mouse with zero lag and keeps moving while
## frozen (where the snapshot yaw is stuck). See _draw for how it's preferred.
func set_local_yaw(yaw: float) -> void:
	_local_live_yaw = yaw
	_has_live_yaw = true
	queue_redraw()

func _process(delta: float) -> void:
	if _rows.is_empty():
		return
	var w := clampf(delta * LERP_RATE, 0.0, 1.0)
	# Only smooth across a seam on axes the active topology actually wraps:
	# plane wraps neither, Mobius wraps x but hard-bounds z, torus/klein wrap
	# both. A non-wrapping axis lerps straight so its dot never hops an edge.
	var wraps_u: bool = _topology != null and _topology.wraps_x()
	var wraps_v: bool = _topology != null and _topology.wraps_z()
	for row in _rows:
		var id: String = row["id"]
		var target: Vector2 = row["target"]
		if _display.has(id):
			var cur: Vector2 = _display[id]
			_display[id] = Vector2(
				_smooth_axis(cur.x, target.x, w, wraps_u),
				_smooth_axis(cur.y, target.y, w, wraps_v),
			)
		else:
			_display[id] = target
	queue_redraw()

## Smooth one normalized axis toward its target. On a wrapping axis the dot
## takes the short path across the seam: when the target is more than half the
## map away it heads for the wrapped target (target +/- 1) and re-enters from
## the opposite edge, so a seam crossing reads as a quick edge hop instead of a
## sweep across the whole map (and repeated crossings stop flickering). A
## non-wrapping axis lerps directly. Static so it can be unit-tested headless.
static func _smooth_axis(current: float, target: float, w: float, wraps: bool) -> float:
	if not wraps:
		return lerpf(current, target, w)
	var diff := target - current
	if diff > 0.5:
		target -= 1.0
	elif diff < -0.5:
		target += 1.0
	return fposmod(lerpf(current, target, w), 1.0)

func _draw() -> void:
	var map_side := minf(size.x, size.y - TALLY_HEIGHT - TALLY_GAP)
	if map_side <= 0.0:
		return
	var map_origin := Vector2((size.x - map_side) * 0.5, 0.0)
	var map_rect := Rect2(map_origin, Vector2(map_side, map_side))
	draw_rect(map_rect, MAP_BG, true)
	draw_rect(map_rect, MAP_BORDER, false, 1.0)
	# Folding topologies show a single copy of the surface in the viewer's frame.
	var folding := _is_folding()
	var local_copy := _copy_of(_display.get(_local_id, Vector2(0.5, 0.5)).x) if folding else false
	# Plot the map dots: teammates always, enemies only under active Radar.
	for row in _rows:
		if row["is_enemy"] and not row["radar"]:
			continue
		var norm: Vector2 = _display.get(row["id"], row["target"])
		var color := _dot_color(row)
		var opposite := false
		if folding:
			var fold := _fold_to_local(norm, local_copy)
			norm = fold["pos"]
			opposite = fold["opposite"]
			if opposite:
				color.a *= FAR_SIDE_ALPHA
		var at := map_origin + norm * map_side
		if row["is_local"]:
			draw_circle(at, LOCAL_DOT_RADIUS + 3.0, Color(color.r, color.g, color.b, 0.25 * color.a))
			draw_circle(at, LOCAL_DOT_RADIUS, color)
			# The snapshot yaw stalls while frozen (the server skips applying input
			# for frozen players), so prefer the live body yaw the arena pushes each
			# frame - it keeps tracking the mouse even while frozen.
			var facing_yaw: float = _local_live_yaw if _has_live_yaw else float(row["yaw"])
			_draw_facing(at, facing_yaw, color)
		else:
			draw_circle(at, DOT_RADIUS, color)
	_draw_tally(map_rect)

## True for topologies drawn as a double cover (Mobius, Klein), where the
## playfield is two mirrored copies of the surface and the minimap fades the
## copy opposite the viewer. Plane/torus are a single copy.
func _is_folding() -> bool:
	if _topology == null:
		return false
	var k = _topology.kind()
	return k == TopologyScript.Kind.MOBIUS or k == TopologyScript.Kind.KLEIN

## Which double-cover copy a normalized u falls on. The two copies split the
## map at u = 0.5 (the mirror seam); the wrap edge at u = 0/1 is the same seam,
## so a dot changes copy whether it crosses the middle or wraps an edge.
static func _copy_of(u: float) -> bool:
	return u >= 0.5

## Fold a full-cover normalized point onto a single copy of the surface, in the
## local viewer's reference frame. Both copies collapse onto u in [0,1] (a point
## and its deck partner u+0.5 land on the same column); a point on the copy
## opposite the viewer mirrors in v so it sits on its partner, and is flagged
## `opposite` so the caller can dim it. Static for headless unit tests.
static func _fold_to_local(norm: Vector2, local_copy: bool) -> Dictionary:
	var opposite := _copy_of(norm.x) != local_copy
	var u := fposmod(norm.x, 0.5) * 2.0
	var v := (1.0 - norm.y) if opposite else norm.y
	return {"pos": Vector2(u, v), "opposite": opposite}

func _dot_color(row: Dictionary) -> Color:
	if row["frozen"]:
		return FROZEN_COLOR
	return Hud.CLOWN_COLOR if row["team"] == "clown" else Hud.MIME_COLOR

func _draw_facing(at: Vector2, yaw: float, color: Color) -> void:
	# Small triangle pointing along the player's yaw. player.gd derives yaw from
	# heading as atan2(-x, -z), so forward in world XZ is (-sin(yaw), -cos(yaw));
	# screen-right is world +x and screen-down is world +z, so that same vector
	# is the screen direction. Only the local dot draws a facing, and the viewer's
	# own copy never folds, so no mirror here.
	var dir := Vector2(-sin(yaw), -cos(yaw))
	var tip := at + dir * (LOCAL_DOT_RADIUS + 5.0)
	var side := dir.orthogonal() * 3.0
	draw_colored_polygon(
		PackedVector2Array([tip, at + side, at - side]), color
	)

func _draw_tally(map_rect: Rect2) -> void:
	var y := map_rect.end.y + TALLY_GAP + TALLY_HEIGHT * 0.5
	var allies: Array = []
	var enemies: Array = []
	for row in _rows:
		if row["is_enemy"]:
			enemies.append(row)
		else:
			allies.append(row)
	var left_x := TALLY_DOT_RADIUS + 1.0
	for i in allies.size():
		draw_circle(Vector2(left_x + i * TALLY_DOT_SPACING, y), TALLY_DOT_RADIUS, _tally_color(allies[i]))
	var right_x := size.x - TALLY_DOT_RADIUS - 1.0
	for i in enemies.size():
		draw_circle(Vector2(right_x - i * TALLY_DOT_SPACING, y), TALLY_DOT_RADIUS, _tally_color(enemies[i]))

func _tally_color(row: Dictionary) -> Color:
	if row["frozen"]:
		return FROZEN_COLOR
	return Hud.CLOWN_COLOR if row["team"] == "clown" else Hud.MIME_COLOR
