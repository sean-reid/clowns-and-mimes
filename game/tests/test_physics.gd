extends "res://tests/test_case.gd"

## Mirrors backend/shared/src/physics.test.ts. Confirms the GDScript port
## of the jump arc + vertical-overlap helpers produces identical values
## to the server. Any divergence here breaks reconciliation in PR 2.

const Physics := preload("res://scripts/physics.gd")

const ARC_MS: int = 600  # JUMP_DURATION_S * 1000

func test_jump_arc_y_returns_hover_when_null_sentinel() -> void:
	assert_approx(Physics.jump_arc_y(-1, 0), Physics.HOVER_HEIGHT)
	assert_approx(Physics.jump_arc_y(-1, 1_000_000), Physics.HOVER_HEIGHT)

func test_jump_arc_y_returns_hover_at_endpoints() -> void:
	assert_approx(Physics.jump_arc_y(1000, 1000), Physics.HOVER_HEIGHT)
	assert_approx(Physics.jump_arc_y(1000, 1000 + ARC_MS), Physics.HOVER_HEIGHT)

func test_jump_arc_y_peaks_at_midpoint() -> void:
	var peak: float = Physics.jump_arc_y(1000, 1000 + ARC_MS / 2)
	assert_approx(peak, Physics.HOVER_HEIGHT + Physics.JUMP_AMP, 0.001)

func test_jump_arc_y_is_symmetric() -> void:
	var earlier: float = Physics.jump_arc_y(0, int(0.25 * ARC_MS))
	var later: float = Physics.jump_arc_y(0, int(0.75 * ARC_MS))
	assert_approx(earlier, later, 0.001)

func test_jump_arc_y_clamps_outside_window() -> void:
	assert_approx(Physics.jump_arc_y(1000, 999), Physics.HOVER_HEIGHT)
	assert_approx(Physics.jump_arc_y(1000, 1000 + ARC_MS + 1), Physics.HOVER_HEIGHT)
	assert_approx(Physics.jump_arc_y(1000, 1000 + 10 * ARC_MS), Physics.HOVER_HEIGHT)

func test_jump_arc_y_is_above_hover_inside_window() -> void:
	for f in [0.01, 0.1, 0.3, 0.7, 0.9, 0.99]:
		var y: float = Physics.jump_arc_y(0, int(f * ARC_MS))
		assert_true(y > Physics.HOVER_HEIGHT, "y=%f at f=%f" % [y, f])

func test_is_jumping_false_for_null_sentinel() -> void:
	assert_false(Physics.is_jumping(-1, 1000))

func test_is_jumping_true_during_arc() -> void:
	assert_true(Physics.is_jumping(1000, 1000))
	assert_true(Physics.is_jumping(1000, 1000 + ARC_MS / 2))
	assert_true(Physics.is_jumping(1000, 1000 + ARC_MS - 1))

func test_is_jumping_false_after_arc() -> void:
	assert_false(Physics.is_jumping(1000, 1000 + ARC_MS))
	assert_false(Physics.is_jumping(1000, 1000 + ARC_MS + 1000))

func test_vertically_overlapping_same_height() -> void:
	assert_true(Physics.vertically_overlapping(Physics.HOVER_HEIGHT, Physics.HOVER_HEIGHT))

func test_vertically_overlapping_just_under_threshold() -> void:
	assert_true(
		Physics.vertically_overlapping(0.0, Physics.BODY_VERTICAL_EXTENT - 0.001)
	)

func test_vertically_overlapping_at_or_past_threshold() -> void:
	assert_false(Physics.vertically_overlapping(0.0, Physics.BODY_VERTICAL_EXTENT))
	assert_false(
		Physics.vertically_overlapping(0.0, Physics.BODY_VERTICAL_EXTENT + 0.001)
	)

func test_vertically_overlapping_symmetric() -> void:
	var lo: float = 0.0
	var hi: float = Physics.BODY_VERTICAL_EXTENT - 0.001
	assert_eq(
		Physics.vertically_overlapping(lo, hi),
		Physics.vertically_overlapping(hi, lo),
	)

func test_vertically_overlapping_peak_evades_grounded() -> void:
	# Option A boundary: a peak jumper just barely evades a grounded
	# attacker. Separation is exactly JUMP_AMP; BODY_VERTICAL_EXTENT is
	# tuned to be just below JUMP_AMP, so the predicate must return false.
	var grounded: float = Physics.HOVER_HEIGHT
	var peak: float = Physics.HOVER_HEIGHT + Physics.JUMP_AMP
	assert_false(Physics.vertically_overlapping(grounded, peak))

const LOCKOUT_MS := 700  # (JUMP_DURATION_S + JUMP_COOLDOWN_S) * 1000

func test_step_jump_triggers_on_first_press() -> void:
	assert_eq(Physics.step_jump(-1, true, 1000), 1000)

func test_step_jump_idle_when_no_press() -> void:
	assert_eq(Physics.step_jump(-1, false, 1000), -1)

func test_step_jump_rejects_press_during_arc() -> void:
	assert_eq(Physics.step_jump(1000, true, 1000 + ARC_MS / 2), 1000)

func test_step_jump_rejects_press_during_cooldown() -> void:
	assert_eq(Physics.step_jump(1000, true, 1000 + ARC_MS + 50), 1000)

func test_step_jump_clears_after_lockout() -> void:
	assert_eq(Physics.step_jump(1000, false, 1000 + LOCKOUT_MS), -1)

func test_step_jump_clears_and_triggers_in_one_tick() -> void:
	assert_eq(Physics.step_jump(1000, true, 1000 + LOCKOUT_MS + 5), 1000 + LOCKOUT_MS + 5)
