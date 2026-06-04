extends RefCounted

## Coverage-aware patrol scoring for the offline bot brain. Mirrors
## backend/room/src/botExploration.ts. A patrolling bot keeps a visit grid
## (cell -> last-visited ms, owned by bot_ai) and favors cells it hasn't seen in
## a while - so it sweeps the map instead of pacing - plus a bias toward
## continuing its heading. Cells are the pathfinder's grid cells (passed in by
## the caller via pathfinder.cell_at), so coverage is topology-correct on every
## map without this module knowing the world extents.

## Record that the bot occupied `cell` (a pathfinder cell index) at now_ms.
## Negative cell = no grid (no labyrinth); skipped.
static func mark_visited(visited: Dictionary, cell: int, now_ms: float) -> void:
	if cell >= 0:
		visited[cell] = now_ms

## Score a candidate patrol point: staleness of its cell (0..1, 1 = never or
## long-ago visited) + a forward bonus for heading the way the bot already
## faces. Higher is better. heading may be zero (no preference). candidate_cell
## is the pathfinder cell of the candidate (negative when there's no grid).
static func patrol_candidate_score(
	candidate: Vector3,
	candidate_cell: int,
	bot_pos: Vector3,
	heading: Vector3,
	visited: Dictionary,
	now_ms: float,
	decay_ms: float,
	momentum_bonus: float
) -> float:
	var age: float = decay_ms
	if candidate_cell >= 0 and visited.has(candidate_cell):
		age = now_ms - float(visited[candidate_cell])
	var staleness: float = clampf(age / decay_ms, 0.0, 1.0)
	var dx: float = candidate.x - bot_pos.x
	var dz: float = candidate.z - bot_pos.z
	var length: float = sqrt(dx * dx + dz * dz)
	var hlen: float = sqrt(heading.x * heading.x + heading.z * heading.z)
	var forward: float = 0.0
	if length > 1e-6 and hlen > 1e-6:
		forward = maxf(0.0, (dx * heading.x + dz * heading.z) / (length * hlen))
	return staleness + momentum_bonus * forward
