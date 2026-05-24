extends RefCounted

## Base class for topology adapters. A topology wraps positions and computes
## distances on the playing field. The XZ plane is the ground; Y is up.
## Most topologies use a centered square of side WIDTH; Klein's double cover
## is 2*WIDTH on x. Adapters expose their actual playfield extents via
## extent_x() / extent_z().

const WIDTH := 80.0

enum Kind { PLANE, TORUS, KLEIN, SPHERE }

## Playfield half-extents along each axis. Overridden by Klein (which has a
## 2*WIDTH x WIDTH double-cover domain). Everything else stays square.
func extent_x() -> float:
	return WIDTH

func extent_z() -> float:
	return WIDTH

func kind() -> Kind:
	push_error("Topology.kind must be overridden")
	return Kind.PLANE

func wrap(position: Vector3) -> Vector3:
	push_error("Topology.wrap must be overridden")
	return position

## Step-aware wrap. Called by the local predictor after computing a
## candidate world position so sphere can route the step through the cube
## identification when it crosses a face boundary. Default: discard prev
## and fall through to wrap(next). Sphere overrides this.
##
## `self.wrap(next)` is spelled with the receiver explicitly because
## Godot's GDScript parser would otherwise resolve `wrap()` to the
## built-in `wrap(value, min, max)` and complain about argument count.
func wrap_step(_prev: Vector3, next: Vector3) -> Vector3:
	return self.wrap(next)

func distance(a: Vector3, b: Vector3) -> float:
	push_error("Topology.distance must be overridden")
	var d := a - b
	d.y = 0.0
	return d.length()

## Shortest displacement that, applied at `from` and then wrapped, lands at `to`.
## Used by bot steering and any other consumer that needs to face the right way
## across a seam. Returns the canonical (a - b) on a flat topology.
func delta(from: Vector3, to: Vector3) -> Vector3:
	var d := to - from
	d.y = 0.0
	return d

func name() -> String:
	push_error("Topology.name must be overridden")
	return ""

func wraps_x() -> bool:
	return false

func wraps_z() -> bool:
	return false

func flips_z_on_x_wrap() -> bool:
	return false

static func half() -> float:
	return WIDTH / 2.0
