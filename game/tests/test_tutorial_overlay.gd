extends "res://tests/test_case.gd"

## Covers the tutorial hint sequence data + advance bookkeeping without
## instantiating the scene (headless has no viewport for the Control nodes).

const Overlay := preload("res://scripts/tutorial_overlay.gd")

func test_five_steps() -> void:
	assert_eq(Overlay.STEPS.size(), 5, "expected five onboarding hints")

func test_every_step_has_text() -> void:
	for step in Overlay.STEPS:
		assert_false(String(step).is_empty(), "hint text must be non-empty")

func test_is_finished_only_past_last_index() -> void:
	assert_false(Overlay.is_finished(0), "first step is not finished")
	assert_false(Overlay.is_finished(4), "last valid index is not finished")
	assert_true(Overlay.is_finished(5), "advancing past the last step finishes")

func test_advancing_through_all_steps_finishes() -> void:
	var index := 0
	while not Overlay.is_finished(index):
		index += 1
	assert_eq(index, Overlay.STEPS.size(), "walks exactly STEPS.size() advances")
