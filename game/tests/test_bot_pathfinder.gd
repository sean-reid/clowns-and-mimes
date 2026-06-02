extends "res://tests/test_case.gd"

## Mirrors backend/room/src/botPathfinder.test.ts: string-pull collapse,
## same-cell passthrough, clearance-aware wall detour, walled-off fallback,
## cell snapping, and soft occupancy routing.

const BotPathfinder := preload("res://scripts/bot_pathfinder.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")

const CELL := 8.0
const HALF := 40.0

func _center(c: int, r: int) -> Vector3:
	return Vector3((c + 0.5) * CELL - HALF, 0.0, (r + 0.5) * CELL - HALF)

func _wall(ax: float, az: float, bx: float, bz: float) -> Dictionary:
	return {"ax": ax, "az": az, "bx": bx, "bz": bz}

func test_collapses_clear_corridor_to_target() -> void:
	var pf := BotPathfinder.new([], "plane")
	var from := _center(1, 5)
	var to := _center(8, 5)
	var wp := pf.next_waypoint(from, to)
	assert_approx(wp.x, to.x, 0.001, "x reaches target")
	assert_approx(wp.z, to.z, 0.001, "z reaches target")

func test_same_cell_returns_target() -> void:
	var pf := BotPathfinder.new([], "plane")
	var to := Vector3(0.5, 0.0, -0.3)
	var wp := pf.next_waypoint(Vector3(0.1, 0.0, 0.2), to)
	assert_approx(wp.x, to.x, 0.001, "same cell -> to.x")
	assert_approx(wp.z, to.z, 0.001, "same cell -> to.z")

func test_routes_around_wall_to_visible_waypoint() -> void:
	var walls := [_wall(0, -HALF, 0, HALF - 2.0 * CELL)]
	var pf := BotPathfinder.new(walls, "plane")
	var from := _center(2, 2)
	var to := _center(7, 2)
	assert_true(WallGeometry.path_crosses_wall(walls, from.x, from.z, to.x, to.z), "direct blocked")
	var wp := pf.next_waypoint(from, to)
	assert_true(
		WallGeometry.path_clears_walls(walls, from.x, from.z, wp.x, wp.z),
		"waypoint is body-reachable, not a corner skim"
	)

func test_falls_back_to_target_when_walled_off() -> void:
	var x0 := 5.0 * CELL - HALF
	var x1 := 6.0 * CELL - HALF
	var z0 := 5.0 * CELL - HALF
	var z1 := 6.0 * CELL - HALF
	var walls := [
		_wall(x0, z0, x1, z0),
		_wall(x0, z1, x1, z1),
		_wall(x0, z0, x0, z1),
		_wall(x1, z0, x1, z1),
	]
	var pf := BotPathfinder.new(walls, "plane")
	var to := _center(5, 5)
	var wp := pf.next_waypoint(_center(1, 1), to)
	assert_approx(wp.x, to.x, 0.001, "walled off -> to.x")
	assert_approx(wp.z, to.z, 0.001, "walled off -> to.z")

func test_cell_center_of_snaps() -> void:
	var pf := BotPathfinder.new([], "plane")
	var c := pf.cell_center_of(Vector3(-35.5, 0.0, -35.2))
	assert_approx(c.x, _center(0, 0).x, 0.001, "snap x")
	assert_approx(c.z, _center(0, 0).z, 0.001, "snap z")

func test_routes_around_occupied_cell() -> void:
	var pf := BotPathfinder.new([], "plane")
	var from := _center(1, 5)
	var to := _center(4, 5)
	# Players parked at the centers of (2,5) and (3,5). The avoidance radius is
	# under one cell, so this penalizes those two cells, forcing a detour.
	var blocked := [2 + 5 * 10, 3 + 5 * 10]
	var avoid := [_center(2, 5), _center(3, 5)]
	var wp := pf.next_waypoint_avoiding(from, to, avoid)
	assert_false(blocked.has(pf.cell_at(wp)), "waypoint not in a penalized cell")

func test_soft_occupancy_passes_through_when_only_route() -> void:
	# Wall with a gap; the only route bends around the tip. Occupy everything but
	# the endpoints: a hard block would give up (return the raw target), the soft
	# cost must still route through and hand back an around-the-tip waypoint.
	var walls := [_wall(0, -HALF, 0, HALF - 2.0 * CELL)]
	var pf := BotPathfinder.new(walls, "plane")
	var from := _center(2, 2)
	var to := _center(7, 2)
	var from_cell := pf.cell_at(from)
	var to_cell := pf.cell_at(to)
	# A player parked in every cell but the endpoints, so any route crosses one.
	var avoid := []
	for cell in 100:
		if cell == from_cell or cell == to_cell:
			continue
		@warning_ignore("integer_division")
		var row := cell / 10
		avoid.append(_center(cell % 10, row))
	var wp := pf.next_waypoint_avoiding(from, to, avoid)
	assert_true(
		WallGeometry.path_clears_walls(walls, from.x, from.z, wp.x, wp.z),
		"found a real route through occupancy"
	)
	assert_false(
		is_equal_approx(wp.x, to.x) and is_equal_approx(wp.z, to.z),
		"did not give up to a straight beeline through the wall"
	)
