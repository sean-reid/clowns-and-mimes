extends "res://scripts/topology/topology.gd"

## Sphere as a cube T-net. The playfield holds six square faces in a 4 x 3
## grid (4*faceSide wide by 3*faceSide tall), with the four equator faces in
## the middle row and the +Y / -Y poles above and below +Z. The six "void"
## cells (top and bottom corners) have no floor; a step into them triggers
## the cube identification rule which transfers the player to the correct
## adjacent face via the cube graph.
##
## This file mirrors backend/shared/src/topology.ts. Movement that crosses a
## face boundary into a void should route through `wrap_step(prev, candidate)`
## - the runtime predictor and contact loops use that path. The pure
## single-point `wrap` here is a recovery: it returns the input unchanged
## when it sits on a face slot, and snaps to the nearest face center if it
## fell into a void.

const FACE_GRID_COLS := 4
const FACE_GRID_ROWS := 3
const FACE_SIDE := WIDTH / float(FACE_GRID_COLS)

# CUBE_FACES order mirrors backend/shared/src/sphereCubeMap.ts.
const CUBE_FACES: Array[String] = ['+Y', '-X', '+Z', '+X', '-Z', '-Y']

# Face -> (col, row) in the 4 x 3 T-net grid. row=0 is the top of the
# playfield (highest z); row=2 is the bottom.
const FACE_SLOTS := {
	'+Y': Vector2i(1, 0),
	'-X': Vector2i(0, 1),
	'+Z': Vector2i(1, 1),
	'+X': Vector2i(2, 1),
	'-Z': Vector2i(3, 1),
	'-Y': Vector2i(1, 2),
}

func kind() -> Kind:
	return Kind.SPHERE

func name() -> String:
	return "sphere"

func extent_x() -> float:
	return float(FACE_GRID_COLS) * FACE_SIDE

func extent_z() -> float:
	return float(FACE_GRID_ROWS) * FACE_SIDE

# Edge adjacency table. Mirrors CUBE_ADJACENCY in
# backend/shared/src/sphereCubeMap.ts. The string keys for the inner dicts
# are 'east', 'north', 'west', 'south'. rotation is the clockwise quarter-
# turn count applied to (u, v) on the destination.
const CUBE_ADJACENCY := {
	'-X': {
		'east': ['+Z', 'west', 0],
		'west': ['-Z', 'east', 0],
		'north': ['+Y', 'west', 3],
		'south': ['-Y', 'west', 1],
	},
	'+Z': {
		'east': ['+X', 'west', 0],
		'west': ['-X', 'east', 0],
		'north': ['+Y', 'south', 0],
		'south': ['-Y', 'north', 0],
	},
	'+X': {
		'east': ['-Z', 'west', 0],
		'west': ['+Z', 'east', 0],
		'north': ['+Y', 'east', 1],
		'south': ['-Y', 'east', 3],
	},
	'-Z': {
		'east': ['-X', 'west', 0],
		'west': ['+X', 'east', 0],
		'north': ['+Y', 'north', 2],
		'south': ['-Y', 'south', 2],
	},
	'+Y': {
		'east': ['+X', 'north', 3],
		'west': ['-X', 'north', 1],
		'north': ['-Z', 'north', 2],
		'south': ['+Z', 'north', 0],
	},
	'-Y': {
		'east': ['+X', 'south', 1],
		'west': ['-X', 'south', 3],
		'north': ['+Z', 'south', 0],
		'south': ['-Z', 'south', 2],
	},
}

func wrap_step(prev: Vector3, next: Vector3) -> Vector3:
	# If the candidate landed on a valid face (grid-adjacent or same face),
	# no cube identification needed. The step continues normally.
	if _face_at(next.x, next.z) != "":
		return next
	# Candidate landed in a T-net void or out of bounds. Identify which
	# edge of the previous face was crossed and teleport to the cube
	# neighbour. Mirrors stepAcrossSphereFaces in sphereCubeMap.ts.
	var from_face := _face_at(prev.x, prev.z)
	if from_face == "":
		return next
	var rect := _face_world_rect(from_face)
	var past_east: float = next.x - rect[1]
	var past_west: float = rect[0] - next.x
	var past_north: float = next.z - rect[3]
	var past_south: float = rect[2] - next.z
	var exits: Array = []
	if past_east > 0.0:
		exits.append(['east', past_east])
	if past_west > 0.0:
		exits.append(['west', past_west])
	if past_north > 0.0:
		exits.append(['north', past_north])
	if past_south > 0.0:
		exits.append(['south', past_south])
	if exits.is_empty():
		return next
	exits.sort_custom(func(a, b): return a[1] > b[1])
	var edge: String = exits[0][0]
	var overshoot: float = exits[0][1]
	var t: float
	match edge:
		'east', 'west':
			t = (next.z - rect[2]) / FACE_SIDE
		_:
			t = (next.x - rect[0]) / FACE_SIDE
	t = clampf(t, 0.0, 1.0)
	var adj: Array = CUBE_ADJACENCY[from_face][edge]
	var to_face: String = adj[0]
	var to_edge: String = adj[1]
	var rotation: int = adj[2]
	var t_dest: float = (1.0 - t) if (rotation % 2) != 0 else t
	var u := 0.5
	var v := 0.5
	match to_edge:
		'east':
			u = 1.0
			v = t_dest
		'west':
			u = 0.0
			v = t_dest
		'north':
			u = t_dest
			v = 1.0
		'south':
			u = t_dest
			v = 0.0
	# Nudge inward off the receiving edge so the next tick is unambiguously
	# inside `to_face`.
	var inward: float = clampf(overshoot / FACE_SIDE, 0.0, 0.999)
	if u == 0.0:
		u = inward
	elif u == 1.0:
		u = 1.0 - inward
	elif v == 0.0:
		v = inward
	elif v == 1.0:
		v = 1.0 - inward
	var dest_rect := _face_world_rect(to_face)
	var world_x: float = dest_rect[0] + u * FACE_SIDE
	var world_z: float = dest_rect[2] + v * FACE_SIDE
	return Vector3(world_x, next.y, world_z)

func wrap(position: Vector3) -> Vector3:
	# Recovery path: if the point sits on a face slot, return it unchanged.
	# If it landed in a void or out of bounds, snap to the nearest face
	# center as a best-effort fallback. The runtime predictor uses
	# stepAcrossSphereFaces (mirrored in movement.gd) for motion crossings
	# so this path is rarely exercised in normal play.
	if _face_at(position.x, position.z) != "":
		return position
	var best_face: String = CUBE_FACES[0]
	var best_dist: float = INF
	for face in CUBE_FACES:
		var rect = _face_world_rect(face)
		var cx = (rect[0] + rect[1]) * 0.5
		var cz = (rect[2] + rect[3]) * 0.5
		var d = (Vector2(position.x - cx, position.z - cz)).length()
		if d < best_dist:
			best_dist = d
			best_face = face
	var rect = _face_world_rect(best_face)
	return Vector3((rect[0] + rect[1]) * 0.5, position.y, (rect[2] + rect[3]) * 0.5)

func distance(a: Vector3, b: Vector3) -> float:
	# Approximate cube geodesic by Euclidean on the unfolded T-net.
	# Exact within a single face; off by the unfold seam for long-range
	# queries. Bot vision and tag radius operate on sub-face distances so
	# the approximation does not bite gameplay.
	return Vector2(b.x - a.x, b.z - a.z).length()

func delta(from: Vector3, to: Vector3) -> Vector3:
	return Vector3(to.x - from.x, 0.0, to.z - from.z)

func wraps_x() -> bool:
	return true

func wraps_z() -> bool:
	return true

func flips_z_on_x_wrap() -> bool:
	return false

# Returns [xMin, xMax, zMin, zMax] for the named face.
func _face_world_rect(face: String) -> Array:
	var slot: Vector2i = FACE_SLOTS[face]
	var ext_x := extent_x()
	var ext_z := extent_z()
	var x_min: float = slot.x * FACE_SIDE - ext_x * 0.5
	var x_max: float = (slot.x + 1) * FACE_SIDE - ext_x * 0.5
	# row=0 sits at the top (highest z), so z_max decreases as row grows.
	var z_max: float = ext_z * 0.5 - slot.y * FACE_SIDE
	var z_min: float = z_max - FACE_SIDE
	return [x_min, x_max, z_min, z_max]

func _face_at(x: float, z: float) -> String:
	for face in CUBE_FACES:
		var rect = _face_world_rect(face)
		if x >= rect[0] and x < rect[1] and z >= rect[2] and z < rect[3]:
			return face
	return ""
