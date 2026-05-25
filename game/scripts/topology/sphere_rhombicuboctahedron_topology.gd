extends "res://scripts/topology/topology.gd"

## Sphere as a rhombicuboctahedron unfolded into an 8x7 planar net.
## 18 walkable squares (6 axials + 12 edge squares) separated by 8
## triangle barriers, replacing the cube T-net's six-face layout.
##
##              col=0 col=1 col=2 col=3 col=4 col=5 col=6 col=7
##   row=0       .    T     ePYn  T     .     .     .     .
##   row=1       .    ePYw  +Y    ePYe  .     .     .     .
##   row=2       .    T     ePYs  T     .     .     .     .
##   row=3      -X    eN    +Z    eS    +X    eR    -Z    eL  (equator belt)
##   row=4       .    T     eNYn  T     .     .     .     .
##   row=5       .    eNYw  -Y    eNYe  .     .     .     .
##   row=6       .    T     eNYs  T     .     .     .     .
##
## `T` cells are triangle barriers (not walkable). Cap arms are 3 cols
## wide centered on +Z's column. Between any pair of cube faces a
## player always crosses one well-defined edge square, so the cube T-net's
## three-faces-meet-at-a-point singularity never appears.
##
## This file mirrors backend/shared/src/sphereRhombicuboctahedron.ts.
## Movement that crosses a face boundary into a void or barrier should
## route through `wrap_step(prev, candidate)`; the runtime predictor and
## contact loops use that path. Keep this file's ADJACENCY table in
## lockstep with the TS reference: any change to one must land on the
## other in the same PR.

const NET_COLS := 8
const NET_ROWS := 7
const FACE_SIDE := WIDTH / float(NET_COLS)

const AXIAL_FACES: Array[String] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z']
const CAP_EDGE_FACES: Array[String] = [
	'ePYn', 'ePYe', 'ePYs', 'ePYw',
	'eNYn', 'eNYe', 'eNYs', 'eNYw',
]
const EQUATOR_EDGE_FACES: Array[String] = ['eN', 'eS', 'eR', 'eL']
const TRIANGLE_FACES: Array[String] = [
	't+x+y+z', 't+x+y-z', 't+x-y+z', 't+x-y-z',
	't-x+y+z', 't-x+y-z', 't-x-y+z', 't-x-y-z',
]

## (col, row) slot for every face. Triangle barriers are present here so
## collision can place walls around them; only walkable faces appear in
## ADJACENCY.
const FACE_SLOTS := {
	# Top cap
	't-x+y-z': Vector2i(1, 0),
	'ePYn':    Vector2i(2, 0),
	't+x+y-z': Vector2i(3, 0),
	'ePYw':    Vector2i(1, 1),
	'+Y':      Vector2i(2, 1),
	'ePYe':    Vector2i(3, 1),
	't-x+y+z': Vector2i(1, 2),
	'ePYs':    Vector2i(2, 2),
	't+x+y+z': Vector2i(3, 2),
	# Equator belt
	'-X': Vector2i(0, 3),
	'eN': Vector2i(1, 3),
	'+Z': Vector2i(2, 3),
	'eS': Vector2i(3, 3),
	'+X': Vector2i(4, 3),
	'eR': Vector2i(5, 3),
	'-Z': Vector2i(6, 3),
	'eL': Vector2i(7, 3),
	# Bottom cap
	't-x-y+z': Vector2i(1, 4),
	'eNYn':    Vector2i(2, 4),
	't+x-y+z': Vector2i(3, 4),
	'eNYw':    Vector2i(1, 5),
	'-Y':      Vector2i(2, 5),
	'eNYe':    Vector2i(3, 5),
	't-x-y-z': Vector2i(1, 6),
	'eNYs':    Vector2i(2, 6),
	't+x-y-z': Vector2i(3, 6),
}

## Walkable-to-walkable edge adjacency. Entries are
## [toFace, toEdge, rotation] where rotation is the clockwise quarter-turn
## count for the (u, v) basis (used to flip the edge parameter when
## rotation is 1 or 3). Mirrors ADJACENCY in
## backend/shared/src/sphereRhombicuboctahedron.ts; edges leading to a
## triangle barrier are intentionally absent (collision handles the wall).
const ADJACENCY := {
	'+X': {
		'east':  ['eR',   'west',  0],
		'west':  ['eS',   'east',  0],
		'north': ['ePYe', 'east',  0],
		'south': ['eNYe', 'east',  3],
	},
	'-X': {
		'east':  ['eN',   'west',  0],
		'west':  ['eL',   'east',  0],
		'north': ['ePYw', 'west',  3],
		'south': ['eNYw', 'west',  0],
	},
	'+Z': {
		'east':  ['eS',   'west',  0],
		'west':  ['eN',   'east',  0],
		'north': ['ePYs', 'south', 0],
		'south': ['eNYn', 'north', 0],
	},
	'-Z': {
		'east':  ['eL',   'west',  0],
		'west':  ['eR',   'east',  0],
		'north': ['ePYn', 'north', 3],
		'south': ['eNYs', 'south', 3],
	},
	'+Y': {
		'east':  ['ePYe', 'west',  0],
		'west':  ['ePYw', 'east',  0],
		'north': ['ePYn', 'south', 0],
		'south': ['ePYs', 'north', 0],
	},
	'-Y': {
		'east':  ['eNYe', 'west',  0],
		'west':  ['eNYw', 'east',  0],
		'north': ['eNYn', 'south', 0],
		'south': ['eNYs', 'north', 0],
	},
	'ePYn': {
		'south': ['+Y', 'north', 0],
		'north': ['-Z', 'north', 1],
	},
	'ePYe': {
		'west': ['+Y', 'east',  0],
		'east': ['+X', 'north', 0],
	},
	'ePYw': {
		'east': ['+Y', 'west',  0],
		'west': ['-X', 'north', 1],
	},
	'ePYs': {
		'north': ['+Y', 'south', 0],
		'south': ['+Z', 'north', 0],
	},
	'eNYn': {
		'north': ['+Z', 'south', 0],
		'south': ['-Y', 'north', 0],
	},
	'eNYe': {
		'west': ['-Y', 'east',  0],
		'east': ['+X', 'south', 1],
	},
	'eNYw': {
		'east': ['-Y', 'west',  0],
		'west': ['-X', 'south', 0],
	},
	'eNYs': {
		'north': ['-Y', 'south', 0],
		'south': ['-Z', 'south', 1],
	},
	'eN': {
		'east': ['+Z', 'west', 0],
		'west': ['-X', 'east', 0],
	},
	'eS': {
		'east': ['+X', 'west', 0],
		'west': ['+Z', 'east', 0],
	},
	'eR': {
		'east': ['-Z', 'west', 0],
		'west': ['+X', 'east', 0],
	},
	'eL': {
		'east': ['-X', 'west', 0],
		'west': ['-Z', 'east', 0],
	},
}

func kind() -> Kind:
	return Kind.SPHERE

func name() -> String:
	return "sphere"

func extent_x() -> float:
	return float(NET_COLS) * FACE_SIDE

func extent_z() -> float:
	return float(NET_ROWS) * FACE_SIDE

func wraps_x() -> bool:
	return true

func wraps_z() -> bool:
	return true

func flips_z_on_x_wrap() -> bool:
	return false

func is_walkable(face: String) -> bool:
	return ADJACENCY.has(face)

func wrap_step(prev: Vector3, next: Vector3) -> Vector3:
	# If the candidate landed on a walkable face, no identification needed.
	if _face_at(next.x, next.z) != "":
		return next
	# Candidate fell into a void / triangle / off-net. Find which edge of
	# the previous face was crossed and apply the polyhedron's identification.
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
	var face_adj: Variant = ADJACENCY.get(from_face)
	if face_adj == null:
		return prev
	var adj: Variant = face_adj.get(edge)
	if adj == null:
		# Edge leads to a wall (triangle barrier). Block the step.
		return prev
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
	# Nudge inward off the receiving edge so the next tick sits unambiguously
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
	# Recovery path: if the point sits on a walkable face, return unchanged.
	# If it landed in a void / triangle / off-net, snap to the nearest
	# walkable face center as a best-effort fallback. The runtime predictor
	# uses wrap_step for normal motion so this path is rarely exercised.
	if _face_at(position.x, position.z) != "":
		return position
	var best_face: String = '+Z'
	var best_dist: float = INF
	for face in ADJACENCY.keys():
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
	# Approximate geodesic by Euclidean on the unfolded net. Exact within
	# a single face; off by the unfold seam for long-range queries. Bot
	# vision and tag radius operate on sub-face distances so the
	# approximation does not bite gameplay.
	return Vector2(b.x - a.x, b.z - a.z).length()

func delta(from: Vector3, to: Vector3) -> Vector3:
	return Vector3(to.x - from.x, 0.0, to.z - from.z)

# Returns [xMin, xMax, zMin, zMax] for the named face. Triangles and
# walkables share the same world-rect math; collision uses this for both.
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

# Returns the walkable face containing (x, z), or "" if the point falls
# on a triangle barrier or off the net.
func _face_at(x: float, z: float) -> String:
	for face in ADJACENCY.keys():
		var rect = _face_world_rect(face)
		if x >= rect[0] and x < rect[1] and z >= rect[2] and z < rect[3]:
			return face
	return ""
