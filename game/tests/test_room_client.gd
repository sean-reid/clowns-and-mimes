extends "res://tests/test_case.gd"

const RoomClientScript := preload("res://scripts/network/room_client.gd")

# Regression for the "stuck after Play Again" bug: the input seq must live on the
# connection and stay monotonic across an arena rebuild, resetting only when a
# brand-new connection opens. A per-arena counter restarted at 0 each match, so
# the rebuilt arena's low seqs landed <= the server's existing high-water mark
# and every input was rejected.
func test_input_seq_persists_until_a_new_connection() -> void:
	var rc: Node = RoomClientScript.new()
	assert_eq(rc.input_seq, 0, "a fresh client starts at seq 0")
	# A match drives this up; Play Again rebuilds the arena but reuses this same
	# RoomClient, so the value must survive.
	rc.input_seq = 12183
	assert_eq(rc.input_seq, 12183, "seq is retained while the connection lives")
	# A brand-new connection talks to a fresh server-side seq tracker, so the
	# counter restarts in lockstep.
	rc.connect_to("ws://127.0.0.1:1")
	assert_eq(rc.input_seq, 0, "opening a new connection restarts the seq")
	rc.disconnect_from()
	rc.free()
