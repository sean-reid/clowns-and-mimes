extends Object

const TopologyScript := preload("res://scripts/topology/topology.gd")
const PLANE_SCRIPT := preload("res://scripts/topology/plane_topology.gd")
const TORUS_SCRIPT := preload("res://scripts/topology/torus_topology.gd")
const KLEIN_SCRIPT := preload("res://scripts/topology/klein_topology.gd")
const MOBIUS_SCRIPT := preload("res://scripts/topology/mobius_topology.gd")

static func create(kind: int) -> TopologyScript:
	match kind:
		TopologyScript.Kind.PLANE:
			return PLANE_SCRIPT.new()
		TopologyScript.Kind.TORUS:
			return TORUS_SCRIPT.new()
		TopologyScript.Kind.MOBIUS:
			return MOBIUS_SCRIPT.new()
		TopologyScript.Kind.KLEIN:
			return KLEIN_SCRIPT.new()
	push_error("unknown topology")
	return PLANE_SCRIPT.new()

static func from_string(value: String) -> TopologyScript:
	match value:
		"plane":
			return create(TopologyScript.Kind.PLANE)
		"torus":
			return create(TopologyScript.Kind.TORUS)
		"mobius":
			return create(TopologyScript.Kind.MOBIUS)
		"klein":
			return create(TopologyScript.Kind.KLEIN)
	push_error("unknown topology string: %s" % value)
	return create(TopologyScript.Kind.PLANE)
