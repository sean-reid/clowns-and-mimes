extends "res://scripts/topology/topology.gd"

## Genus-2 closed surface (double torus) as a regular octagonal
## fundamental polygon with the textbook side identification:
##
##     a b a^-1 b^-1 c d c^-1 d^-1
##
## Same-letter sides glue across the polygon with the parameter reversed.
## Mate(side k) = k XOR 2:  0<->2, 1<->3, 4<->6, 5<->7.
##
## All 8 polygon vertices identify to a single cone point on the closed
## surface. That's the only singularity; the playfield interior is smooth
## and uniformly walkable.
##
## This file mirrors backend/shared/src/genus2.ts. Keep the geometry
## constants and identification logic in lockstep; client and server must
## compute the same wrap result for the same input.

const OCTAGON_CIRCUMRADIUS := 40.0
const SIDE_COUNT := 8

## (col, row) doesn't apply to the octagon; the playfield is just the
## interior of the polygon. Extents come from the bounding box.

var _vertices: Array  # of Vector2(x, z)
var _side_starts: Array
var _side_ends: Array
var _side_tangents: Array
var _side_outward: Array
var _side_lengths: Array

func _init() -> void:
	_vertices = []
	_side_starts = []
	_side_ends = []
	_side_tangents = []
	_side_outward = []
	_side_lengths = []
	# 8 vertices on a circle of radius OCTAGON_CIRCUMRADIUS, CCW from +x axis.
	for k in range(SIDE_COUNT):
		var theta: float = PI / 4.0 * float(k)
		_vertices.append(Vector2(cos(theta) * OCTAGON_CIRCUMRADIUS, sin(theta) * OCTAGON_CIRCUMRADIUS))
	# 8 sides: V_k -> V_{k+1}.
	for k in range(SIDE_COUNT):
		var v0: Vector2 = _vertices[k]
		var v1: Vector2 = _vertices[(k + 1) % SIDE_COUNT]
		var length: float = v0.distance_to(v1)
		var tangent: Vector2 = (v1 - v0) / length
		# For a CCW-traversed convex polygon, outward normal is the tangent
		# rotated -90 deg: (tx, tz) -> (tz, -tx).
		var outward: Vector2 = Vector2(tangent.y, -tangent.x)
		_side_starts.append(v0)
		_side_ends.append(v1)
		_side_tangents.append(tangent)
		_side_outward.append(outward)
		_side_lengths.append(length)

func kind() -> Kind:
	return Kind.GENUS2

func name() -> String:
	return "genus2"

func extent_x() -> float:
	return 2.0 * OCTAGON_CIRCUMRADIUS

func extent_z() -> float:
	return 2.0 * OCTAGON_CIRCUMRADIUS

func wraps_x() -> bool:
	return true

func wraps_z() -> bool:
	return true

func flips_z_on_x_wrap() -> bool:
	return false

func mate_side(side_idx: int) -> int:
	return side_idx ^ 2

## Signed perpendicular distance from p to side `side_idx`. Positive
## when p lies outside that side (in the excluded half-plane).
func signed_distance_to_side(p: Vector2, side_idx: int) -> float:
	var s_start: Vector2 = _side_starts[side_idx]
	var s_outward: Vector2 = _side_outward[side_idx]
	return (p.x - s_start.x) * s_outward.x + (p.y - s_start.y) * s_outward.y

func point_in_octagon(p: Vector2) -> bool:
	for k in range(SIDE_COUNT):
		if signed_distance_to_side(p, k) > 1e-9:
			return false
	return true

func side_of_boundary(p: Vector2) -> int:
	var best_side: int = -1
	var best_dist: float = 1e-9
	for k in range(SIDE_COUNT):
		var d: float = signed_distance_to_side(p, k)
		if d > best_dist:
			best_dist = d
			best_side = k
	return best_side

func parametrize_along_side(p: Vector2, side_idx: int) -> float:
	var s_start: Vector2 = _side_starts[side_idx]
	var s_tangent: Vector2 = _side_tangents[side_idx]
	var s_length: float = _side_lengths[side_idx]
	var projection: float = (p.x - s_start.x) * s_tangent.x + (p.y - s_start.y) * s_tangent.y
	return clampf(projection / s_length, 0.0, 1.0)

func point_on_side(side_idx: int, t: float) -> Vector2:
	var s_start: Vector2 = _side_starts[side_idx]
	var s_end: Vector2 = _side_ends[side_idx]
	return s_start + (s_end - s_start) * t

func inward_normal(side_idx: int) -> Vector2:
	return -Vector2(_side_outward[side_idx])

func wrap_step(prev: Vector3, next: Vector3) -> Vector3:
	var p_next := Vector2(next.x, next.z)
	if point_in_octagon(p_next):
		return next
	var side_idx: int = side_of_boundary(p_next)
	if side_idx < 0:
		return next
	var t: float = parametrize_along_side(p_next, side_idx)
	var overshoot: float = signed_distance_to_side(p_next, side_idx)
	var m: int = mate_side(side_idx)
	var arrival: Vector2 = point_on_side(m, 1.0 - t)
	var inw: Vector2 = inward_normal(m)
	var landed: Vector2 = arrival + overshoot * inw
	return Vector3(landed.x, next.y, landed.y)

func wrap(position: Vector3) -> Vector3:
	# Recovery wrap. Interior points pass through. Exterior points are
	# identified through their crossing side; if the destination is also
	# outside (very rare double-exterior), fall back to the polygon centre.
	var p := Vector2(position.x, position.z)
	if point_in_octagon(p):
		return position
	var side_idx: int = side_of_boundary(p)
	if side_idx < 0:
		return position
	var t: float = parametrize_along_side(p, side_idx)
	var overshoot: float = signed_distance_to_side(p, side_idx)
	var m: int = mate_side(side_idx)
	var arrival: Vector2 = point_on_side(m, 1.0 - t)
	var inw: Vector2 = inward_normal(m)
	var landed: Vector2 = arrival + overshoot * inw
	if point_in_octagon(landed):
		return Vector3(landed.x, position.y, landed.y)
	return Vector3(0.0, position.y, 0.0)

func distance(a: Vector3, b: Vector3) -> float:
	# Euclidean inside the polygon. Cross-boundary geodesics are not yet
	# computed; sub-octagon distance (the only thing AI vision and the tag
	# radius care about) is exact.
	return Vector2(b.x - a.x, b.z - a.z).length()

func delta(from: Vector3, to: Vector3) -> Vector3:
	return Vector3(to.x - from.x, 0.0, to.z - from.z)
