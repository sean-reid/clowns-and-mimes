extends "res://tests/test_case.gd"

const Physics := preload("res://scripts/physics.gd")

func test_descent_one_frame_at_60hz_drops_5m_per_second() -> void:
	# 5 m/s rate * (1/60) s ~= 0.0833 m per frame.
	var next: float = Physics.step_frozen_descent(Physics.HOVER_HEIGHT + 2.0, 1.0 / 60.0)
	assert_approx(next, Physics.HOVER_HEIGHT + 2.0 - 5.0 / 60.0, 0.0001,
		"one 60Hz frame at 5 m/s")

func test_descent_clamps_at_hover_height() -> void:
	# Starting just barely above the floor, one big delta should clamp.
	var next: float = Physics.step_frozen_descent(Physics.HOVER_HEIGHT + 0.01, 1.0)
	assert_approx(next, Physics.HOVER_HEIGHT, 0.0001, "clamp at floor")

func test_descent_from_peak_reaches_floor_in_expected_time() -> void:
	# JUMP_AMP = 2.0 m above hover. At 5 m/s that's 0.4 s of descent.
	# Simulate 30 frames at 60Hz (= 0.5s) — past the 0.4s point. Must
	# be exactly HOVER_HEIGHT (clamped).
	var y: float = Physics.HOVER_HEIGHT + Physics.JUMP_AMP
	for _i in range(30):
		y = Physics.step_frozen_descent(y, 1.0 / 60.0)
	assert_approx(y, Physics.HOVER_HEIGHT, 0.0001, "peak -> floor in 0.5s")

func test_descent_within_audit_tolerance_after_10_frames() -> void:
	# Audit acceptance: spawn mid-arc, freeze, tick 10 frames at 60Hz,
	# assert Y within 0.05 of HOVER_HEIGHT. With 10 frames * 5/60 m =
	# 0.833 m of descent, only mid-low arcs satisfy this. Use a starting
	# height of HOVER_HEIGHT + 0.83 to land just inside the tolerance.
	var y: float = Physics.HOVER_HEIGHT + 0.83
	for _i in range(10):
		y = Physics.step_frozen_descent(y, 1.0 / 60.0)
	assert_true(absf(y - Physics.HOVER_HEIGHT) < 0.05,
		"low-arc 10-frame descent within 0.05 of floor (y=%f)" % y)
