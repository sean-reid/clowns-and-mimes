extends RefCounted

## Analytic wall collision for bot planning, mirrors backend/shared/src/
## labyrinth.ts (path_crosses_wall / path_clears_walls + the segment-distance
## helpers). The player's real collision is the physics StaticBody walls; this
## is the planning-side mirror the bot pathfinder and steering use for
## clearance-aware line of sight, so offline matches the server's geometry.
##
## Walls are dicts {ax, az, bx, bz} in world XZ, the shape grid_maze.gd emits.

const SharedConstants := preload("res://scripts/shared_constants.gd")

const WALL_HALF_THICKNESS := SharedConstants.WALL_THICKNESS / 2.0
const WALL_CLEARANCE := SharedConstants.WALL_THICKNESS / 2.0 + SharedConstants.PLAYER_RADIUS

## Does the segment (ax,az)->(bx,bz) cross any wall, accounting for the wall's
## half-thickness and refusing moves that push deeper into the clearance band?
## Mirrors pathCrossesWall: blocks tunnelling and moving-further-in, but allows
## a parallel or escaping slide already inside the band.
static func path_crosses_wall(walls: Array, ax: float, az: float, bx: float, bz: float) -> bool:
	for w in walls:
		if _segments_intersect(ax, az, bx, bz, w.ax, w.az, w.bx, w.bz):
			return true
		var end_dist := _point_to_segment_distance(bx, bz, w)
		if end_dist >= WALL_CLEARANCE:
			continue
		var start_dist := _point_to_segment_distance(ax, az, w)
		if end_dist < start_dist - 1e-6:
			return true
	return false

## Can a body of radius `clearance` travel the whole segment without coming
## within the wall's solid half-thickness? Mirrors pathClearsWalls: rejects a
## path that merely skims a wall tip, so the pathfinder never shortcuts a
## waypoint the body can't actually reach.
static func path_clears_walls(
	walls: Array, ax: float, az: float, bx: float, bz: float, clearance: float = WALL_CLEARANCE
) -> bool:
	for w in walls:
		if _segment_to_segment_distance(ax, az, bx, bz, w.ax, w.az, w.bx, w.bz) < clearance:
			return false
	return true

## True if a disc of radius WALL_CLEARANCE centered at (x,z) overlaps any wall.
static func point_blocked_by_wall(walls: Array, x: float, z: float) -> bool:
	for w in walls:
		if _point_to_segment_distance(x, z, w) < WALL_CLEARANCE:
			return true
	return false

## Distance from (x, z) to the nearest wall centerline, or INF when there are no
## walls. Feeds the bot pathfinder's continuous wall-avoidance cost field.
## Mirrors labyrinth.ts nearestWallDistance.
static func nearest_wall_distance(walls: Array, x: float, z: float) -> float:
	var best := INF
	for w in walls:
		var d := _point_to_segment_distance(x, z, w)
		if d < best:
			best = d
	return best

static func _segments_intersect(
	ax: float, az: float, bx: float, bz: float, cx: float, cz: float, dx: float, dz: float
) -> bool:
	var r1 := _orient(ax, az, bx, bz, cx, cz)
	var r2 := _orient(ax, az, bx, bz, dx, dz)
	var r3 := _orient(cx, cz, dx, dz, ax, az)
	var r4 := _orient(cx, cz, dx, dz, bx, bz)
	return r1 != r2 and r3 != r4

static func _orient(ax: float, az: float, bx: float, bz: float, cx: float, cz: float) -> int:
	var v := (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
	if v > 1e-9:
		return 1
	if v < -1e-9:
		return -1
	return 0

static func _point_to_segment_distance(px: float, pz: float, w: Dictionary) -> float:
	var dx: float = w.bx - w.ax
	var dz: float = w.bz - w.az
	var len_sq := dx * dx + dz * dz
	if len_sq < 1e-9:
		return sqrt((px - w.ax) * (px - w.ax) + (pz - w.az) * (pz - w.az))
	var t: float = ((px - w.ax) * dx + (pz - w.az) * dz) / len_sq
	t = clampf(t, 0.0, 1.0)
	var qx: float = w.ax + dx * t
	var qz: float = w.az + dz * t
	return sqrt((px - qx) * (px - qx) + (pz - qz) * (pz - qz))

## Shortest distance between two segments: 0 if they cross, else the smallest
## endpoint-to-other-segment distance.
static func _segment_to_segment_distance(
	ax: float, az: float, bx: float, bz: float, cx: float, cz: float, dx: float, dz: float
) -> float:
	if _segments_intersect(ax, az, bx, bz, cx, cz, dx, dz):
		return 0.0
	var seg1 := {"ax": ax, "az": az, "bx": bx, "bz": bz}
	var seg2 := {"ax": cx, "az": cz, "bx": dx, "bz": dz}
	return minf(
		minf(
			_point_to_segment_distance(ax, az, seg2),
			_point_to_segment_distance(bx, bz, seg2),
		),
		minf(
			_point_to_segment_distance(cx, cz, seg1),
			_point_to_segment_distance(dx, dz, seg1),
		)
	)
