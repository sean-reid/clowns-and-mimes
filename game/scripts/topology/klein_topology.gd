extends "res://scripts/topology/topology.gd"

## Klein bottle. The walkable surface is the double cover: a 2*WIDTH (x) by
## WIDTH (z) torus where the right half of the maze is the z-mirror of the
## left half. The bottle's z-orientation flip is therefore realised as
## traversable space - the player walks through the mirrored half before
## reaching the seam at +-WIDTH - instead of an instantaneous flip on each
## x-seam crossing. Wraps on both axes are plain modular.
##
## Mirrors backend/shared/src/topology.ts (klein branch).

const X_PERIOD := 2.0 * WIDTH

func kind() -> Kind:
	return Kind.KLEIN

func name() -> String:
	return "klein"

func extent_x() -> float:
	return X_PERIOD

func extent_z() -> float:
	return WIDTH

func wrap(position: Vector3) -> Vector3:
	var hx := X_PERIOD / 2.0
	var hz := WIDTH / 2.0
	var wx := fposmod(position.x + hx, X_PERIOD) - hx
	var wz := fposmod(position.z + hz, WIDTH) - hz
	return Vector3(wx, position.y, wz)

func distance(a: Vector3, b: Vector3) -> float:
	return Vector2(_wrapped_delta_x(a.x, b.x), _wrapped_delta_z(a.z, b.z)).length()

func delta(from: Vector3, to: Vector3) -> Vector3:
	return Vector3(_wrapped_delta_x(from.x, to.x), 0.0, _wrapped_delta_z(from.z, to.z))

func wraps_x() -> bool:
	return true

func wraps_z() -> bool:
	return true

func flips_z_on_x_wrap() -> bool:
	# The z-flip is in the geometry of the right half, not in the wrap rule.
	# Callers that build wrap-tile clones use this to decide whether to
	# z-mirror neighbor tiles; for the double cover the tiles do NOT need
	# the per-tile flip.
	return false

func _wrapped_delta_x(a: float, b: float) -> float:
	var d := fposmod(b - a, X_PERIOD)
	if d > X_PERIOD / 2.0:
		d -= X_PERIOD
	return d

func _wrapped_delta_z(a: float, b: float) -> float:
	var d := fposmod(b - a, WIDTH)
	if d > WIDTH / 2.0:
		d -= WIDTH
	return d
