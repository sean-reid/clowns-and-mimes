extends RefCounted

## Offline power-up system. The deterministic floor layout + type rotation
## mirror backend/shared/src/items.ts; the live lifecycle (respawn + pickup)
## mirrors backend/room/src/itemManager.ts. Online mode gets item state from the
## server snapshot instead - this only runs in offline play.
##
## Constants are hardcoded-mirrored from items.ts (same approach grid_maze.gd
## takes for the maze generator); the determinism tests guard against drift.
## The LCG is reused from grid_maze so both draw from the identical stream.

const GridMaze := preload("res://scripts/grid_maze.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")

const WORLD_WIDTH := 80.0
const ITEM_RESPAWN_MS := 30000
const ITEM_PICKUP_RADIUS := 1.6
const ITEM_SPAWN_KEEP_DENOM := 3
const ITEM_TYPES_ALWAYS := ["surge", "radar"]
const ITEM_TYPES_ROTATING := ["leap", "portal", "clone", "overcharge", "cloak"]
# Team-spawn + centroid cells, excluded so items don't land on spawning players.
const EXCLUDED_CENTERS := [Vector3(-12, 0, 4), Vector3(12, 0, 4), Vector3(0, 0, 0)]

# id -> {id, type, position: Vector3, respawn_at: int(ms, 0 = on the floor)}
var _items: Dictionary = {}

## surge + radar always, plus 1-3 from the rotating pool (3-5 total).
## Deterministic in seed; mirrors items.ts::rotateItemTypes.
static func rotate_item_types(seed_value: int) -> Array:
	var state: int = seed_value & 0xFFFFFFFF
	var pool: Array = ITEM_TYPES_ROTATING.duplicate()
	for i in range(pool.size() - 1, 0, -1):
		state = GridMaze._lcg_next(state)
		var j: int = state % (i + 1)
		var tmp = pool[i]
		pool[i] = pool[j]
		pool[j] = tmp
	state = GridMaze._lcg_next(state)
	var extra: int = 1 + (state % 3)
	var out: Array = ITEM_TYPES_ALWAYS.duplicate()
	for k in extra:
		out.append(pool[k])
	return out

## One item per ~KEEP_DENOM-th walkable cell (spawn/centroid cells excluded),
## type drawn from the rotation. Mirrors items.ts::itemSpawnLayout. Returns
## [{id, type, position: Vector3}, ...].
static func item_spawn_layout(seed_value: int, topology_name: String) -> Array:
	var g: Dictionary = _grid_geom(topology_name)
	var rotation: Array = rotate_item_types(seed_value)
	var excluded: Dictionary = {}
	for c in EXCLUDED_CENTERS:
		excluded[_cell_index_at(c, g)] = true
	var state: int = (seed_value ^ 0x9e3779b9) & 0xFFFFFFFF
	var out: Array = []
	for r in g.rows:
		for col in g.cols:
			var cell: int = col + r * g.cols
			if excluded.has(cell):
				continue
			state = GridMaze._lcg_next(state)
			if state % ITEM_SPAWN_KEEP_DENOM != 0:
				continue
			state = GridMaze._lcg_next(state)
			var t: String = rotation[state % rotation.size()]
			out.append({"id": "i-%d" % cell, "type": t, "position": _cell_center(col, r, g)})
	return out

## Build the floor from the seed. Called at match start.
func spawn(seed_value: int, topology_name: String) -> void:
	_items.clear()
	for entry in item_spawn_layout(seed_value, topology_name):
		_items[entry.id] = {
			"id": entry.id, "type": entry.type, "position": entry.position, "respawn_at": 0
		}

## Items currently on the floor (for the renderer): [{id, type, position}, ...].
func available() -> Array:
	var out: Array = []
	for it in _items.values():
		if it.respawn_at == 0:
			out.append({"id": it.id, "type": it.type, "position": it.position})
	return out

## Respawn elapsed items, then let each eligible player grab one available item.
## A frozen player or one already holding an item can't pick up; one pickup per
## player per tick. Mutates the player dicts (sets active_item). Returns the
## pickup events [{item_id, player_id}] for the caller to surface/render.
func step(now_ms: int, players: Array, topology: TopologyScript) -> Array:
	for it in _items.values():
		if it.respawn_at != 0 and it.respawn_at <= now_ms:
			it.respawn_at = 0
	var events: Array = []
	for p in players:
		if p.get("frozen", false) or p.get("active_item", "") != "":
			continue
		for it in _items.values():
			if it.respawn_at != 0:
				continue
			if topology.distance(p.position, it.position) > ITEM_PICKUP_RADIUS:
				continue
			p["active_item"] = it.type
			it.respawn_at = now_ms + ITEM_RESPAWN_MS
			events.append({"item_id": it.id, "player_id": p.id})
			break
	return events

## Clear the held slot and return the type used ("" when empty). Effect
## application is the caller's job (per-type, lands in the effects pass).
func use_item(player: Dictionary) -> String:
	var t: String = player.get("active_item", "")
	if t == "":
		return ""
	player["active_item"] = ""
	return t

static func _grid_geom(topology_name: String) -> Dictionary:
	var n: int = GridMaze.GRID_MAZE_N
	if topology_name == "klein":
		var cell: float = WORLD_WIDTH / n
		return {
			"cols": 2 * n, "rows": n, "cell_x": cell, "cell_z": cell,
			"half_x": WORLD_WIDTH, "half_z": WORLD_WIDTH / 2.0
		}
	if topology_name == "mobius":
		var cols: int = GridMaze.MOBIUS_GRID_X
		var rows: int = GridMaze.MOBIUS_GRID_Z
		return {
			"cols": cols, "rows": rows,
			"cell_x": 2.0 * GridMaze.MOBIUS_HALF_X / cols,
			"cell_z": 2.0 * GridMaze.MOBIUS_HALF_Z / rows,
			"half_x": GridMaze.MOBIUS_HALF_X, "half_z": GridMaze.MOBIUS_HALF_Z
		}
	var cell: float = WORLD_WIDTH / n
	return {
		"cols": n, "rows": n, "cell_x": cell, "cell_z": cell,
		"half_x": WORLD_WIDTH / 2.0, "half_z": WORLD_WIDTH / 2.0
	}

static func _cell_center(c: int, r: int, g: Dictionary) -> Vector3:
	return Vector3((c + 0.5) * g.cell_x - g.half_x, 0.0, (r + 0.5) * g.cell_z - g.half_z)

static func _cell_index_at(pos: Vector3, g: Dictionary) -> int:
	var c: int = clampi(floori((pos.x + g.half_x) / g.cell_x), 0, g.cols - 1)
	var r: int = clampi(floori((pos.z + g.half_z) / g.cell_z), 0, g.rows - 1)
	return c + r * g.cols
