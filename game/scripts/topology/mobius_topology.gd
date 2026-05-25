extends "res://scripts/topology/topology.gd"

## Möbius strip topology. The playfield is the rectangle
## [-Lx, Lx] x [-Lz, Lz] with the textbook one-twist identification:
##
##     (-Lx, z)  ~  (+Lx, -z)
##
## Left and right edges glue with a z-flip. Top and bottom (z = +/- Lz)
## are hard walls (the strip's single boundary loop in our rectangle
## parametrisation). The universal cover is the infinite flat strip, so
## the rendering is exact: flat tiling and pure-translation/reflection
## edge portals.
##
## Mirrors backend/shared/src/mobius.ts. Keep wrap_step + the safe-nudge
## constants in lockstep so client prediction matches server-authoritative
## movement.

const MOBIUS_HALF_X := 40.0
const MOBIUS_HALF_Z := 20.0

# Inward displacement clamped onto every wrap_step destination. Mirrors
# WALL_CLEARANCE (0.6) plus a small epsilon so float-precision wobble
# can't pin the player against a maze wall along the boundary on the
# next tick.
const SAFE_INWARD := 0.65

func kind() -> Kind:
	return Kind.MOBIUS

func name() -> String:
	return "mobius"

func extent_x() -> float:
	return 2.0 * MOBIUS_HALF_X

func extent_z() -> float:
	return 2.0 * MOBIUS_HALF_Z

func wraps_x() -> bool:
	return true

func wraps_z() -> bool:
	return false

func flips_z_on_x_wrap() -> bool:
	return true

func wrap_step(prev: Vector3, next: Vector3) -> Vector3:
	# z bounds first: top and bottom are hard walls. The collision system
	# clips most of these via labyrinth walls; this final guard catches
	# anything that slipped through.
	if next.z > MOBIUS_HALF_Z + 1e-6 or next.z < -MOBIUS_HALF_Z - 1e-6:
		return prev
	if next.x > MOBIUS_HALF_X:
		var overshoot: float = next.x - MOBIUS_HALF_X
		var inward: float = maxf(overshoot, SAFE_INWARD)
		return Vector3(-MOBIUS_HALF_X + inward, next.y, -next.z)
	if next.x < -MOBIUS_HALF_X:
		var overshoot: float = -MOBIUS_HALF_X - next.x
		var inward: float = maxf(overshoot, SAFE_INWARD)
		return Vector3(MOBIUS_HALF_X - inward, next.y, -next.z)
	return next

func wrap(position: Vector3) -> Vector3:
	# Recovery: interior passes through; past +/-Lx identifies with z-flip;
	# past +/-Lz clamps to the boundary (hard wall, no wrap available).
	var x: float = position.x
	var z: float = position.z
	if x > MOBIUS_HALF_X:
		var overshoot: float = x - MOBIUS_HALF_X
		x = -MOBIUS_HALF_X + minf(overshoot, 2.0 * MOBIUS_HALF_X)
		z = -z
	elif x < -MOBIUS_HALF_X:
		var overshoot: float = -MOBIUS_HALF_X - x
		x = MOBIUS_HALF_X - minf(overshoot, 2.0 * MOBIUS_HALF_X)
		z = -z
	if z > MOBIUS_HALF_Z:
		z = MOBIUS_HALF_Z
	elif z < -MOBIUS_HALF_Z:
		z = -MOBIUS_HALF_Z
	return Vector3(x, position.y, z)

func distance(a: Vector3, b: Vector3) -> float:
	# Shortest path on the flat universal cover: pick the minimum of the
	# direct chord and the two x-wrap-with-z-flip chords.
	var direct: float = Vector2(b.x - a.x, b.z - a.z).length()
	var wrap_r: float = Vector2(b.x - (a.x + 2.0 * MOBIUS_HALF_X), b.z - (-a.z)).length()
	var wrap_l: float = Vector2(b.x - (a.x - 2.0 * MOBIUS_HALF_X), b.z - (-a.z)).length()
	return minf(minf(direct, wrap_r), wrap_l)

func delta(from: Vector3, to: Vector3) -> Vector3:
	# Same shortest-path selection as distance() so bot steering heads
	# through the seam when it's the closer route.
	var direct := Vector3(to.x - from.x, 0.0, to.z - from.z)
	var wrap_r := Vector3(
		to.x - (from.x + 2.0 * MOBIUS_HALF_X),
		0.0,
		-to.z - from.z,
	)
	var wrap_l := Vector3(
		to.x - (from.x - 2.0 * MOBIUS_HALF_X),
		0.0,
		-to.z - from.z,
	)
	var d_direct: float = Vector2(direct.x, direct.z).length()
	var d_r: float = Vector2(wrap_r.x, wrap_r.z).length()
	var d_l: float = Vector2(wrap_l.x, wrap_l.z).length()
	if d_direct <= d_r and d_direct <= d_l:
		return direct
	if d_r <= d_l:
		return wrap_r
	return wrap_l

## Edge portal transforms. Used by labyrinth.gd to render the strip's
## interior at x outside [-Lx, Lx] so the player sees continuous geometry
## across the seam. The transform is a pure translation along x plus a
## z-reflection: rendering a copy of the maze at x += 2*Lx with z
## negated places the destination side just past the right edge, exactly
## the geometry the player will inhabit after wrap_step. No rotation.
func portal_transforms() -> Array:
	return [
		{ "tx": 2.0 * MOBIUS_HALF_X, "flip_z": true },   # right portal
		{ "tx": -2.0 * MOBIUS_HALF_X, "flip_z": true },  # left portal
	]
