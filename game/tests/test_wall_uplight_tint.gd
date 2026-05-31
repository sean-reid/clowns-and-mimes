extends "res://tests/test_case.gd"

## Covers the pure phase-name -> tint Color mapping on labyrinth.gd. Called as
## a static via load() so no scene tree is needed.

const Labyrinth := preload("res://scripts/labyrinth.gd")

func test_turn_clown_is_warm() -> void:
	var c: Color = Labyrinth.tint_for_phase("turn_clown")
	assert_true(c.r > c.b, "clown tint warm (red > blue)")

func test_turn_mime_is_cool() -> void:
	var c: Color = Labyrinth.tint_for_phase("turn_mime")
	assert_true(c.b > c.r, "mime tint cool (blue > red)")

func test_neutral_phases() -> void:
	assert_eq(Labyrinth.tint_for_phase("free_roam"), Color(1.0, 1.0, 1.0), "free_roam neutral")
	assert_eq(Labyrinth.tint_for_phase("filling"), Color(1.0, 1.0, 1.0), "filling neutral")
	assert_eq(Labyrinth.tint_for_phase("unknown"), Color(1.0, 1.0, 1.0), "unknown neutral")
