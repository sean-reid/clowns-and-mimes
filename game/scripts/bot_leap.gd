extends RefCounted

## Leap traversal for the offline bot brain. Mirrors backend/room/src/botLeap.ts.
## A normal jump can't clear a wall (its arc peaks below WALL_HEIGHT) but a Leap
## can, and the movement layer stops blocking a body's XZ once it's above the
## wall - so a chasing/rescuing bot holding a Leap hops a wall in the way of its
## goal instead of pathing around. True when leaping straight at `goal` crosses a
## wall within `reach` and lands on open ground past it.

const TopologyScript := preload("res://scripts/topology/topology.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")

static func should_leap_traverse(
	bot_pos: Vector3, goal: Vector3, walls: Array, topology: TopologyScript, reach: float
) -> bool:
	if walls.is_empty():
		return false
	var d: Vector3 = topology.delta(bot_pos, goal)
	d.y = 0.0
	var l: float = d.length()
	if l < 1e-6:
		return false
	var dir: Vector3 = d / l
	var land: Vector3 = topology.wrap(bot_pos + dir * reach)
	# A wall must lie between the bot and the landing point, and the landing must
	# be clear (so the bot lands past the wall, not embedded in it).
	if not WallGeometry.path_crosses_wall(walls, bot_pos.x, bot_pos.z, land.x, land.z):
		return false
	return not WallGeometry.point_blocked_by_wall(walls, land.x, land.z)
