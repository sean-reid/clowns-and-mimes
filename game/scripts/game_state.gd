extends Node

## Singleton holding cross-scene state.

signal mode_changed(mode: String)
signal topology_changed(topology: String)
## Fired when the menu's connectivity probe resolves or the state changes, so
## screens can reflect connecting / online / offline without re-querying.
signal connectivity_changed(state: int, reason: String)

enum Topology { PLANE, TORUS, MOBIUS, KLEIN }
enum Mode { OFFLINE, HOST, JOIN, OPEN }
# UNKNOWN before the first probe; CONNECTING while one is in flight; then ONLINE
# (matchmaker reachable) or OFFLINE (unreachable). connectivity_reason explains
# OFFLINE ("no_connection"; "out_of_date" reserved for a version mismatch
# surfaced on an action).
enum Connectivity { UNKNOWN, CONNECTING, ONLINE, OFFLINE }

const TOPOLOGY_NAMES := {
	Topology.PLANE: "plane",
	Topology.TORUS: "torus",
	Topology.MOBIUS: "mobius",
	Topology.KLEIN: "klein",
}

var username: String = ""
var mode: Mode = Mode.OFFLINE
var topology: Topology = Topology.PLANE
var connectivity: Connectivity = Connectivity.UNKNOWN
var connectivity_reason: String = ""
var lobby_code: String = ""
var server_url: String = ""
# Host token from the matchmaker create response. Sent on the WS join so the
# room can identify which connected player is the host, gating start_match.
# Empty for non-host (JOIN / OPEN) modes - they never see it.
var host_token: String = ""
# True when this client holds the host role for a private room - either it
# created the lobby (host_token set) or the server promoted it after the
# original host left (host_changed event). Gates the host-only UI (lobby Start,
# end-screen Play Again); a promoted player has no host_token, so the UI can't
# key off the token alone. Reset alongside host_token on every fresh queue.
var is_room_host: bool = false
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
# How the party screen should open: "create" auto-creates a party, "join"
# auto-joins party_join_code, "" shows the manual entry view. Set by the menu
# so the create/join choice lives in the navigation tree, not the party screen.
var party_intent: String = ""
var party_join_code: String = ""
# Which menu_v2 panel to open on entry (e.g. "joinparty"), instead of the root.
# Lets a screen hand the player back to a specific menu panel - leaving a party
# returns to the join-by-code panel rather than the party screen. "" = root.
var menu_panel: String = ""

func _ready() -> void:
	randomize()

func set_mode(new_mode: Mode) -> void:
	mode = new_mode
	mode_changed.emit(str(new_mode))

func set_topology(new_topology: Topology) -> void:
	topology = new_topology
	topology_changed.emit(TOPOLOGY_NAMES[topology])

func set_connectivity(state: Connectivity, reason: String = "") -> void:
	connectivity = state
	connectivity_reason = reason
	connectivity_changed.emit(int(state), reason)

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
