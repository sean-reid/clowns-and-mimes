extends "res://scripts/topology/topology.gd"

## Möbius strip rendered as a CYLINDRICAL DOUBLE COVER.
##
## The fundamental Möbius strip identifies (x, z) ~ (x + L, -z). Rendering
## that z-flip live at the seam looks jarring (walls jump, camera mirrors),
## so the playfield is the orientation double cover: a cylinder of twice
## the strip's length, where the right half is the z-mirror of the left.
## Walking around the cylinder visits both "sides" of the Möbius surface;
## the wrap at +/-MOBIUS_HALF_X is pure modular - no z-flip - so the
## seam is butter-smooth, just like the torus seam.
##
## Mirrors backend/shared/src/mobius.ts. Same trick Klein uses on its
## x-seam, with z hard-bounded instead of wrapping.

const MOBIUS_HALF_X := 80.0
const MOBIUS_HALF_Z := 20.0

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
	return false

func wrap_step(prev: Vector3, next: Vector3) -> Vector3:
	if next.z > MOBIUS_HALF_Z + 1e-6 or next.z < -MOBIUS_HALF_Z - 1e-6:
		return prev
	return Vector3(_wrap_modular(next.x, 2.0 * MOBIUS_HALF_X), next.y, next.z)

func wrap(position: Vector3) -> Vector3:
	var x: float = _wrap_modular(position.x, 2.0 * MOBIUS_HALF_X)
	var z: float = position.z
	if z > MOBIUS_HALF_Z:
		z = MOBIUS_HALF_Z
	elif z < -MOBIUS_HALF_Z:
		z = -MOBIUS_HALF_Z
	return Vector3(x, position.y, z)

func distance(a: Vector3, b: Vector3) -> float:
	var dx: float = _wrapped_delta(a.x, b.x, 2.0 * MOBIUS_HALF_X)
	var dz: float = b.z - a.z
	return Vector2(dx, dz).length()

func delta(from: Vector3, to: Vector3) -> Vector3:
	var dx: float = _wrapped_delta(from.x, to.x, 2.0 * MOBIUS_HALF_X)
	var dz: float = to.z - from.z
	return Vector3(dx, 0.0, dz)

func _wrap_modular(v: float, period: float) -> float:
	var half: float = period * 0.5
	return fposmod(v + half, period) - half

func _wrapped_delta(a: float, b: float, period: float) -> float:
	var d: float = fposmod(b - a, period)
	if d > period * 0.5:
		return d - period
	return d
