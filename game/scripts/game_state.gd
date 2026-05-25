extends Node

## Singleton holding cross-scene state.

signal mode_changed(mode: String)
signal topology_changed(topology: String)

enum Topology { PLANE, TORUS, MOBIUS, KLEIN }
enum Mode { OFFLINE, HOST, JOIN, OPEN }

const TOPOLOGY_NAMES := {
	Topology.PLANE: "plane",
	Topology.TORUS: "torus",
	Topology.MOBIUS: "mobius",
	Topology.KLEIN: "klein",
}

var username: String = ""
var mode: Mode = Mode.OFFLINE
var topology: Topology = Topology.PLANE
var lobby_code: String = ""
var server_url: String = ""

func _ready() -> void:
	randomize()

func set_mode(new_mode: Mode) -> void:
	mode = new_mode
	mode_changed.emit(str(new_mode))

func set_topology(new_topology: Topology) -> void:
	topology = new_topology
	topology_changed.emit(TOPOLOGY_NAMES[topology])

func topology_as_string() -> String:
	return TOPOLOGY_NAMES[topology]

func ensure_username() -> String:
	if username.is_empty():
		username = UsernameGenerator.generate()
	return username
