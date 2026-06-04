extends "res://tests/test_case.gd"

## Unit coverage for the telemetry helpers that are pure enough to test without
## the autoload's network/consent state. distance_bucket maps a projectile_hit's
## shooter-to-victim distance to the schema's bucket label, shared by the online
## and offline emit sites so the same shot buckets identically.

const Telemetry := preload("res://scripts/network/telemetry.gd")

func test_distance_bucket_boundaries() -> void:
	# close: <= CLOSE_MAX
	assert_eq(Telemetry.distance_bucket(0.0), "close", "point blank")
	assert_eq(Telemetry.distance_bucket(Telemetry.HIT_BUCKET_CLOSE_MAX), "close", "close edge")
	# medium: (CLOSE_MAX, MEDIUM_MAX]
	assert_eq(
		Telemetry.distance_bucket(Telemetry.HIT_BUCKET_CLOSE_MAX + 0.01), "medium", "just over close"
	)
	assert_eq(Telemetry.distance_bucket(Telemetry.HIT_BUCKET_MEDIUM_MAX), "medium", "medium edge")
	# far: > MEDIUM_MAX
	assert_eq(
		Telemetry.distance_bucket(Telemetry.HIT_BUCKET_MEDIUM_MAX + 0.01), "far", "just over medium"
	)
	assert_eq(Telemetry.distance_bucket(100.0), "far", "long range")
