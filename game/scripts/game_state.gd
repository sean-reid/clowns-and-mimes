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
# Host token from the matchmaker create response. Sent on the WS join so the
# room can identify which connected player is the host, gating start_match.
# Empty for non-host (JOIN / OPEN) modes - they never see it.
var host_token: String = ""
# Party handle + the caller's member id, set on the party screen and carried
# into the lobby so an open-as-party join routes everyone to the same room.
# Empty when not queuing as a party.
var party_id: String = ""
var party_member_id: String = ""
# Team the matchmaker assigned the party; passed as the WS join `preferTeam`
# so the whole party lands on one team. Empty for solo / host / join-by-code.
var prefer_team: String = ""
# Host picked "Random" topology. The concrete shape is rolled client-side at
# lobby create (the server only ever sees real topologies); the flag persists
# so the replay path can re-roll a fresh shape on each new game in the room.
var host_random_topology: bool = false

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

# Rolls one of the four concrete topologies and applies it. Called when the
# host chose "Random" so the matchmaker request carries a real shape.
func roll_random_topology() -> void:
	set_topology(Topology.values()[randi() % Topology.size()] as Topology)

func ensure_username() -> String:
	if username.is_empty():
		username = UsernameGenerator.generate()
	return username
