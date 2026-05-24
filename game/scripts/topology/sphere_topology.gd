extends "res://scripts/topology/topology.gd"

## Sphere with a 3x2 cube-face packing for the labyrinth. This first cut wraps
## torus-like (modular wrap on both axes) so a player crossing a face edge
## reappears on the opposite side of the playfield. The 3x2 packing fills the
## full WIDTH x WIDTH domain, so modular wrap is the right primitive for now.
##
## TODO: proper cube-net edge adjacency with rotations when crossing a face
## boundary, and proper sphere geodesic distance between cells on different
## faces. Mirrors backend/shared/src/topology.ts.

func kind() -> Kind:
	return Kind.SPHERE

func name() -> String:
	return "sphere"

func wrap(position: Vector3) -> Vector3:
	return Vector3(_wrap_axis(position.x), position.y, _wrap_axis(position.z))

func distance(a: Vector3, b: Vector3) -> float:
	return Vector2(_wrapped_delta(a.x, b.x), _wrapped_delta(a.z, b.z)).length()

func delta(from: Vector3, to: Vector3) -> Vector3:
	return Vector3(_wrapped_delta(from.x, to.x), 0.0, _wrapped_delta(from.z, to.z))

func wraps_x() -> bool:
	return true

func wraps_z() -> bool:
	return true

func flips_z_on_x_wrap() -> bool:
	return false

func _wrap_axis(value: float) -> float:
	var h := half()
	var w := fposmod(value + h, WIDTH)
	return w - h

func _wrapped_delta(a: float, b: float) -> float:
	var d := fposmod(b - a, WIDTH)
	if d > WIDTH / 2.0:
		d -= WIDTH
	return d
