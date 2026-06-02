extends "res://tests/test_case.gd"

## Mirrors the pathCrossesWall / pathClearsWalls cases in
## backend/shared/src/labyrinth.test.ts so the offline collision mirror can't
## drift from the server's.

const WallGeometry := preload("res://scripts/wall_geometry.gd")

func _wall(ax: float, az: float, bx: float, bz: float) -> Dictionary:
	return {"ax": ax, "az": az, "bx": bx, "bz": bz}

func test_path_crosses_wall_blocks_tunnelling() -> void:
	var walls := [_wall(5, -5, 5, 5)]
	assert_true(WallGeometry.path_crosses_wall(walls, 0, 0, 10, 0), "crosses vertical wall")
	assert_false(WallGeometry.path_crosses_wall(walls, 0, 0, 4, 0), "stops short of wall")

func test_path_crosses_wall_allows_escape_from_clearance_band() -> void:
	# Body at z=0.55, just inside clearance of a wall at z=0.
	var walls := [_wall(-10, 0, 10, 0)]
	assert_false(WallGeometry.path_crosses_wall(walls, 0, 0.55, 1, 0.55), "parallel slide allowed")
	assert_false(WallGeometry.path_crosses_wall(walls, 0, 0.55, 0, 1.0), "moving away allowed")
	assert_true(WallGeometry.path_crosses_wall(walls, 0, 0.55, 0, 0.3), "deeper in blocked")
	assert_true(WallGeometry.path_crosses_wall(walls, 0, 0.55, 0, -1.0), "tunnelling blocked")

func test_path_clears_walls_rejects_tip_skim() -> void:
	# Vertical wall whose top tip is at (5, 0); a path at z=0.5 never crosses it
	# but skims the tip within the body radius.
	var walls := [_wall(5, -10, 5, 0)]
	assert_false(WallGeometry.path_crosses_wall(walls, 0, 0.5, 10, 0.5), "no crossing")
	assert_false(WallGeometry.path_clears_walls(walls, 0, 0.5, 10, 0.5), "but body skims tip")

func test_path_clears_walls_accepts_clear_path() -> void:
	var walls := [_wall(5, -10, 5, 0)]
	assert_true(WallGeometry.path_clears_walls(walls, 0, 5, 10, 5), "well clear")

func test_path_clears_walls_rejects_crossing() -> void:
	var walls := [_wall(5, -10, 5, 0)]
	assert_false(WallGeometry.path_clears_walls(walls, 0, -5, 10, -5), "crosses the wall")

func test_path_clears_walls_honors_custom_clearance() -> void:
	var walls := [_wall(5, -10, 5, 0)]
	assert_true(WallGeometry.path_clears_walls(walls, 0, 0.5, 10, 0.5, 0.4), "0.4 body clears")
	assert_false(WallGeometry.path_clears_walls(walls, 0, 0.5, 10, 0.5, 0.9), "0.9 body does not")

func test_path_clears_walls_with_no_walls() -> void:
	assert_true(WallGeometry.path_clears_walls([], 0, 0, 100, 100), "nothing to clear")
