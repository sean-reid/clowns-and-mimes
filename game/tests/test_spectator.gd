extends "res://tests/test_case.gd"

const Spectator := preload("res://scripts/spectator.gd")
const SharedConstants := preload("res://scripts/shared_constants.gd")

# The spectator camera renders a teammate's POV: positioned at their eye
# (body + EYE_HEIGHT) and oriented with their yaw + pitch.
func test_eye_position_raises_body_by_eye_height() -> void:
	var eye := Spectator.eye_position(Vector3(3.0, 0.5, -7.0))
	assert_approx(eye.x, 3.0, 0.0001, "eye keeps x")
	assert_approx(eye.y, 0.5 + SharedConstants.EYE_HEIGHT, 0.0001, "eye raised by EYE_HEIGHT")
	assert_approx(eye.z, -7.0, 0.0001, "eye keeps z")

func test_look_rotation_composes_yaw_and_pitch() -> void:
	var r := Spectator.look_rotation(1.2, -0.3)
	assert_approx(r.y, 1.2, 0.0001, "yaw about Y")
	assert_approx(r.x, -0.3, 0.0001, "pitch about X")
	assert_approx(r.z, 0.0, 0.0001, "no roll")

func test_is_teammate_target() -> void:
	assert_true(Spectator.is_teammate_target("mime", false, "mime"), "same team, not frozen")
	assert_false(Spectator.is_teammate_target("clown", false, "mime"), "other team is not a target")
	assert_false(Spectator.is_teammate_target("mime", true, "mime"), "frozen teammate is skipped")
