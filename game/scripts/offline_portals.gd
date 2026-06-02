extends RefCounted

## Portal-pair geometry for offline play. Pure port of
## backend/shared/src/portals.ts: the entry mouth lands on the wall the player
## faces (ray-cast from look yaw), the exit on a random other wall, and each
## mouth gets an off-wall emergence point a player lands on when pulled through.
## The offline manager owns the live pairs + teleport (mirrors itemManager's
## portal handling); this is just the geometry.
##
## Walls are {ax, az, bx, bz} dicts. Returns a geom dict:
##   {a:Vector3, b:Vector3, a_exit:Vector3, b_exit:Vector3,
##    a_exit_yaw:float, b_exit_yaw:float} (mouths/exits in world XZ, y=0), or {}
## when there are no walls.

const SharedConstants := preload("res://scripts/shared_constants.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")

const PORTAL_DURATION_MS := int(SharedConstants.PORTAL_DURATION_MS)
const PORTAL_ENTER_RADIUS := SharedConstants.PORTAL_ENTER_RADIUS
const PORTAL_EXIT_OFFSET := SharedConstants.PORTAL_EXIT_OFFSET
const PORTAL_TELEPORT_COOLDOWN_MS := int(SharedConstants.PORTAL_TELEPORT_COOLDOWN_MS)
const PORTAL_MOUTH_RADIUS := SharedConstants.PORTAL_MOUTH_RADIUS
const WALL_CLEARANCE := WallGeometry.WALL_CLEARANCE
const RAY_MAX := 200.0

# Off-wall offsets + tangential slides tried, in order, for the emergence point.
static func _emerge_offsets() -> Array:
	return [PORTAL_EXIT_OFFSET, PORTAL_EXIT_OFFSET * 1.5, PORTAL_EXIT_OFFSET * 0.75]

static func _emerge_slides() -> Array:
	return [0.0, PORTAL_MOUTH_RADIUS, -PORTAL_MOUTH_RADIUS]

# Forward unit vector for a look yaw (matches player.gd target_yaw = atan2(-x,-z)).
static func forward_from_yaw(yaw: float) -> Vector2:
	return Vector2(-sin(yaw), -cos(yaw))

static func yaw_from_forward(fx: float, fz: float) -> float:
	return atan2(-fx, -fz)

## Build a portal pair from the opener's position + look yaw. `rng` is a
## Callable returning a float in [0,1) for the random exit-wall pick.
static func build_portal_pair(
	ox: float, oz: float, yaw: float, walls: Array, topology: TopologyScript, rng: Callable
) -> Dictionary:
	if walls.is_empty():
		return {}
	var f := forward_from_yaw(yaw)
	var hit := _ray_hit(ox, oz, f.x, f.y, walls)
	if hit.is_empty():
		hit = _nearest_wall(walls, ox, oz)
	var entry_wall: Dictionary = hit.wall
	var exit_wall: Dictionary = entry_wall
	if walls.size() > 1:
		while true:
			exit_wall = walls[int(rng.call() * walls.size())]
			if exit_wall != entry_wall:
				break
	var entry := _clamp_onto_wall(entry_wall, hit.x, hit.z, PORTAL_MOUTH_RADIUS)
	var exit_mid := _clamp_onto_wall(
		exit_wall,
		(exit_wall.ax + exit_wall.bx) / 2.0,
		(exit_wall.az + exit_wall.bz) / 2.0,
		PORTAL_MOUTH_RADIUS
	)
	var a_emerge := _emerge(entry_wall, entry.x, entry.y, Vector2(ox, oz), walls, topology)
	var b_emerge := _emerge(exit_wall, exit_mid.x, exit_mid.y, null, walls, topology)
	return {
		"a": Vector3(entry.x, 0.0, entry.y),
		"b": Vector3(exit_mid.x, 0.0, exit_mid.y),
		"a_exit": a_emerge.point,
		"b_exit": b_emerge.point,
		"a_exit_yaw": a_emerge.yaw,
		"b_exit_yaw": b_emerge.yaw,
	}

# Off-wall emergence point + the yaw facing away from the wall. `toward` (the
# opener's position, or null for the random exit) biases to that player's side.
static func _emerge(
	wall: Dictionary, mx: float, mz: float, toward, walls: Array, topology: TopologyScript
) -> Dictionary:
	var ex: float = wall.bx - wall.ax
	var ez: float = wall.bz - wall.az
	var length: float = sqrt(ex * ex + ez * ez)
	if length < 1e-9:
		length = 1.0
	var nx := -ez / length
	var nz := ex / length
	var tx := ex / length
	var tz := ez / length
	var sides := [1.0, -1.0]
	if toward != null:
		var side: float = (toward.x - mx) * nx + (toward.y - mz) * nz
		sides = [1.0, -1.0] if side >= 0.0 else [-1.0, 1.0]
	var best_point := Vector2(mx, mz)
	var best_clear := -INF
	var best_side := 1.0
	for side in sides:
		for off in _emerge_offsets():
			for slide in _emerge_slides():
				var raw := Vector3(mx + nx * off * side + tx * slide, 0.0, mz + nz * off * side + tz * slide)
				var w: Vector3 = topology.wrap(raw)
				var clr := _clearance(walls, w.x, w.z)
				if clr > best_clear:
					best_clear = clr
					best_point = Vector2(w.x, w.z)
					best_side = side
				if clr >= WALL_CLEARANCE:
					return {
						"point": Vector3(w.x, 0.0, w.z), "yaw": yaw_from_forward(nx * side, nz * side)
					}
	return {
		"point": Vector3(best_point.x, 0.0, best_point.y),
		"yaw": yaw_from_forward(nx * best_side, nz * best_side),
	}

# Nearest forward wall the ray (ox,oz)+t*(dx,dz) crosses, or {} if none.
static func _ray_hit(ox: float, oz: float, dx: float, dz: float, walls: Array) -> Dictionary:
	var best := {}
	var best_t := INF
	for w in walls:
		var ex: float = w.bx - w.ax
		var ez: float = w.bz - w.az
		var denom := dx * ez - dz * ex
		if absf(denom) < 1e-9:
			continue
		var t: float = ((w.ax - ox) * ez - (w.az - oz) * ex) / denom
		var u: float = ((w.ax - ox) * dz - (w.az - oz) * dx) / denom
		if t < 0.0 or t > RAY_MAX or u < 0.0 or u > 1.0:
			continue
		if best.is_empty() or t < best_t:
			best_t = t
			best = {"wall": w, "x": ox + dx * t, "z": oz + dz * t}
	return best

# Closest point on the closest wall to (x,z). Fallback when the look ray misses.
static func _nearest_wall(walls: Array, x: float, z: float) -> Dictionary:
	var best := {}
	var best_d := INF
	for w in walls:
		var dx: float = w.bx - w.ax
		var dz: float = w.bz - w.az
		var len_sq := dx * dx + dz * dz
		var t: float = 0.0 if len_sq < 1e-9 else clampf(((x - w.ax) * dx + (z - w.az) * dz) / len_sq, 0.0, 1.0)
		var cx: float = w.ax + dx * t
		var cz: float = w.az + dz * t
		var d := sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz))
		if d < best_d:
			best_d = d
			best = {"wall": w, "x": cx, "z": cz}
	return best

# Project (px,pz) onto a wall, kept `inset` from each end. Returns Vector2(x,z).
static func _clamp_onto_wall(w: Dictionary, px: float, pz: float, inset: float) -> Vector2:
	var dx: float = w.bx - w.ax
	var dz: float = w.bz - w.az
	var length := sqrt(dx * dx + dz * dz)
	if length < 1e-9:
		return Vector2(w.ax, w.az)
	var t: float = ((px - w.ax) * dx + (pz - w.az) * dz) / (length * length)
	var margin := inset / length if length >= 2.0 * inset else 0.5
	t = clampf(t, margin, 1.0 - margin)
	return Vector2(w.ax + dx * t, w.az + dz * t)

static func _seg_distance(px: float, pz: float, w: Dictionary) -> float:
	var dx: float = w.bx - w.ax
	var dz: float = w.bz - w.az
	var len_sq := dx * dx + dz * dz
	if len_sq < 1e-9:
		return sqrt((px - w.ax) * (px - w.ax) + (pz - w.az) * (pz - w.az))
	var t: float = clampf(((px - w.ax) * dx + (pz - w.az) * dz) / len_sq, 0.0, 1.0)
	var cx: float = w.ax + dx * t
	var cz: float = w.az + dz * t
	return sqrt((px - cx) * (px - cx) + (pz - cz) * (pz - cz))

static func _clearance(walls: Array, x: float, z: float) -> float:
	var m := INF
	for w in walls:
		var d := _seg_distance(x, z, w)
		if d < m:
			m = d
	return m
