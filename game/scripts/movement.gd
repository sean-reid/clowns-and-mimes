extends RefCounted
class_name Movement

## GDScript port of backend/shared/src/movement.ts. The local-player predictor
## must use identical math to the server's stepMovement, otherwise the
## reconciliation replay drifts from the server's authoritative position.
##
## Constants and helpers mirror backend/shared/src/{movement.ts, labyrinth.ts,
## topology.ts}. Keep them in lockstep: any change to step rules, wall
## collision, or wrap behavior on one side must land on the other in the same
## PR.

const SharedConstants := preload("res://scripts/shared_constants.gd")

const WALK_SPEED := SharedConstants.WALK_SPEED
const SPRINT_SPEED := SharedConstants.SPRINT_SPEED
# Single-tick travel cap derived from SPRINT_SPEED * 1.5 on both sides.
const MAX_TICK_TRAVEL := SPRINT_SPEED * 1.5
const MAX_SPRINT := SharedConstants.MAX_SPRINT
const SPRINT_DRAIN_PER_S := SharedConstants.SPRINT_DRAIN_PER_S
const SPRINT_REGEN_PER_S := SharedConstants.SPRINT_REGEN_PER_S
const SPRINT_ENGAGE_THRESHOLD := SharedConstants.SPRINT_ENGAGE_THRESHOLD

# Wall collision parameters. Local to this file (not in shared) because
# wall geometry lives only in @cm/shared/labyrinth on the TS side; the
# client mirrors here. Both sides still need to agree; keep manually.
const WALL_THICKNESS := 0.4
const WALL_HALF_THICKNESS := WALL_THICKNESS / 2.0
const PLAYER_RADIUS := 0.4
const WALL_CLEARANCE := WALL_HALF_THICKNESS + PLAYER_RADIUS

const TopologyScript := preload("res://scripts/topology/topology.gd")

## One server tick of humanoid movement. Returns
##   {"position": Vector2(x, z), "sprint_energy": float}
## position uses the (x, z) plane (matching the server's Vec2); the caller is
## responsible for keeping y in sync. topology.wrap() handles seam wrapping.
##
## walls is an Array of {ax, az, bx, bz} dictionaries (labyrinth.wall_endpoints).
static func step(
	state: Dictionary,
	input: Dictionary,
	walls: Array,
	topology,
) -> Dictionary:
	var pos: Vector2 = state["position"]
	var sprint_energy: float = state["sprint_energy"]
	var sprinting: bool = state.get("sprinting", false)
	var move: Vector2 = input["move"]
	var sprint_held: bool = input["sprint"]
	var dt: float = input["dt"]

	# Hysteresis: while already sprinting any positive energy keeps it alive;
	# once disengaged, sprint can only re-arm above SPRINT_ENGAGE_THRESHOLD.
	# Mirrors backend/shared/src/movement.ts.
	var want_sprint: bool = false
	if sprint_held and sprint_energy > 0.0:
		if sprinting:
			want_sprint = true
		else:
			want_sprint = sprint_energy >= SPRINT_ENGAGE_THRESHOLD
	var speed: float = SPRINT_SPEED if want_sprint else WALK_SPEED
	var move_len: float = move.length()
	var nx: float = move.x / move_len if move_len > 0.0 else 0.0
	var nz: float = move.y / move_len if move_len > 0.0 else 0.0
	var dx: float = nx * speed * dt
	var dz: float = nz * speed * dt
	var travel: float = sqrt(dx * dx + dz * dz)
	var scale: float = (MAX_TICK_TRAVEL * dt) / travel if travel > MAX_TICK_TRAVEL * dt else 1.0
	var candidates: Array = [
		Vector2(pos.x + dx * scale, pos.y + dz * scale),
		Vector2(pos.x + sign(dx) * speed * dt, pos.y),
		Vector2(pos.x, pos.y + sign(dz) * speed * dt),
	]
	var next_pos: Vector2 = pos
	for c in candidates:
		var candidate: Vector2 = c
		if candidate.x == pos.x and candidate.y == pos.y:
			continue
		if walls.size() > 0 and path_crosses_wall(walls, pos.x, pos.y, candidate.x, candidate.y):
			continue
		# Player-on-player collision is server-authoritative. During the
		# client predict step we cannot know every other body's position at
		# this input's tick, so we always pass the candidate; the server
		# enforces it and the next delta will snap us back if we walked
		# through someone.
		var wrapped3: Vector3 = topology.wrap_step(
			Vector3(pos.x, 0.0, pos.y),
			Vector3(candidate.x, 0.0, candidate.y),
		)
		next_pos = Vector2(wrapped3.x, wrapped3.z)
		break

	# Wall rebound (mirrors stepMovement in backend/shared/src/movement.ts).
	# If the chosen candidate lost motion to a blocked candidate, apply a
	# tiny opposite push proportional to BOUNCE_E_WALL so the body visibly
	# "bumps" off the wall instead of dead-stopping. Keeps reconcile drift
	# at zero since the server applies the same rebound.
	const PhysicsScript := preload("res://scripts/physics.gd")
	var attempted_dx: float = candidates[0].x - pos.x
	var attempted_dz: float = candidates[0].y - pos.y
	var actual_dx: float = next_pos.x - pos.x
	var actual_dz: float = next_pos.y - pos.y
	var loss_dx: float = attempted_dx - actual_dx
	var loss_dz: float = attempted_dz - actual_dz
	var loss_mag: float = sqrt(loss_dx * loss_dx + loss_dz * loss_dz)
	var attempted_mag: float = sqrt(attempted_dx * attempted_dx + attempted_dz * attempted_dz)
	# Skip rebound when the apparent "loss" is actually a topology wrap.
	# A genuine partial-block loss is bounded by the attempted step
	# (slide loses one axis, full block loses both); anything larger
	# means next_pos jumped to the far side of a seam, and rebounding
	# off that would shove the body off the playfield. The 1.5x slack
	# handles float-precision near the boundary without false-allowing
	# real wraps (which are at minimum WIDTH / 2 in magnitude, way past
	# the 1.5x window for any plausible single-tick step).
	if (
		attempted_mag > 0.0
		and loss_mag <= attempted_mag * 1.5
		and loss_mag / attempted_mag > 0.1
	):
		var rebound_x: float = -loss_dx * PhysicsScript.BOUNCE_E_WALL
		var rebound_z: float = -loss_dz * PhysicsScript.BOUNCE_E_WALL
		var candidate_xz := Vector2(next_pos.x + rebound_x, next_pos.y + rebound_z)
		var rebound_blocked: bool = (
			walls.size() > 0
			and path_crosses_wall(
				walls, next_pos.x, next_pos.y, candidate_xz.x, candidate_xz.y
			)
		)
		if not rebound_blocked:
			next_pos = candidate_xz

	var drained: bool = want_sprint and move_len > 0.0
	var energy_delta: float = (-SPRINT_DRAIN_PER_S if drained else SPRINT_REGEN_PER_S) * dt
	var next_energy: float = clampf(sprint_energy + energy_delta, 0.0, MAX_SPRINT)
	var next_sprinting: bool = want_sprint and next_energy > 0.0
	return {
		"position": next_pos,
		"sprint_energy": next_energy,
		"sprinting": next_sprinting,
	}

## Push `self_xz` out of overlap with every entry in `others_xz`.
## Mirrors the position-resolution half of
## backend/shared/src/movement.ts::resolvePlayerCollisions so the client
## predictor matches what the server's resolvePlayerCollisions will do.
## Skips the closing-velocity impulse the server adds; that small
## per-tick delta gets corrected by the next reconcile and is too
## brittle to mirror precisely without per-other prev positions.
##
## Distance + push direction are computed via topology.delta so wrapping
## seams don't flip the result. Without this the predictor briefly sees
## bots on the opposite side of the world (until the next render frame
## flips their _to_camera_nearest_copy rendered position), misses the
## overlap entirely, and the server's bounce pass produces a visible
## reconcile snap on every seam crossing. topology being null means the
## caller is in offline / pre-build mode; fall back to raw Euclidean.
##
## Skips entries that are wall-blocked: a push into a wall would create
## the same wall-clipping we are trying to avoid. The unblocked others
## still resolve their share.
static func resolve_overlap(
	self_xz: Vector2,
	others_xz: Array,
	walls: Array,
	topology = null,
) -> Vector2:
	var result := self_xz
	for other in others_xz:
		var other_xz: Vector2 = other
		var diff_x: float
		var diff_z: float
		if topology != null:
			var d: Vector3 = topology.delta(
				Vector3(other_xz.x, 0.0, other_xz.y),
				Vector3(result.x, 0.0, result.y),
			)
			diff_x = d.x
			diff_z = d.z
		else:
			diff_x = result.x - other_xz.x
			diff_z = result.y - other_xz.y
		var dist: float = sqrt(diff_x * diff_x + diff_z * diff_z)
		if dist >= 2.0 * PLAYER_RADIUS:
			continue
		var nx: float
		var nz: float
		if dist > 1e-6:
			nx = diff_x / dist
			nz = diff_z / dist
		else:
			# Zero-distance fallback. Pick a deterministic axis so both
			# server and client agree.
			nx = 1.0
			nz = 0.0
		var overlap: float = 2.0 * PLAYER_RADIUS - dist
		var candidate := Vector2(result.x + nx * overlap, result.y + nz * overlap)
		if walls.size() > 0 and path_crosses_wall(walls, result.x, result.y, candidate.x, candidate.y):
			continue
		result = candidate
	# Wrap after the push so the result stays in the canonical domain. A
	# contact near a seam can shove the position outside, and on the next
	# predict tick with zero input stepMovement leaves an extended position
	# unchanged - the predictor then renders at extended one frame and the
	# _physics_process wrap snaps it back the next, producing the seam
	# flicker. Mirrors the same wrap on the server in
	# backend/shared/src/movement.ts::resolvePlayerCollisions.
	if topology != null:
		var wrapped: Vector3 = topology.wrap(Vector3(result.x, 0.0, result.y))
		result = Vector2(wrapped.x, wrapped.z)
	return result

static func path_crosses_wall(walls: Array, ax: float, az: float, bx: float, bz: float) -> bool:
	# Block moves that take the body closer to a wall than WALL_CLEARANCE
	# allows. The end-only "is it deeper than the start?" check accepts a
	# move when the body is already inside the clearance band and either
	# stays at the same depth (parallel slide) or moves further out - escape
	# paths a "start-or-end" check would have pinned. The segment-
	# intersection test still stops a move from tunneling through the wall,
	# so this is safe. Mirrors backend/shared/src/labyrinth.ts::pathCrossesWall.
	for w in walls:
		var wax: float = w["ax"]
		var waz: float = w["az"]
		var wbx: float = w["bx"]
		var wbz: float = w["bz"]
		if _segments_intersect(ax, az, bx, bz, wax, waz, wbx, wbz):
			return true
		var end_dist: float = _point_to_segment_dist(bx, bz, wax, waz, wbx, wbz)
		if end_dist >= WALL_CLEARANCE:
			continue
		var start_dist: float = _point_to_segment_dist(ax, az, wax, waz, wbx, wbz)
		if end_dist < start_dist - 1e-6:
			return true
	return false

static func _segments_intersect(
	ax: float, az: float, bx: float, bz: float,
	cx: float, cz: float, dx: float, dz: float,
) -> bool:
	var r1: int = _orient(ax, az, bx, bz, cx, cz)
	var r2: int = _orient(ax, az, bx, bz, dx, dz)
	var r3: int = _orient(cx, cz, dx, dz, ax, az)
	var r4: int = _orient(cx, cz, dx, dz, bx, bz)
	return r1 != r2 and r3 != r4

static func _orient(ax: float, az: float, bx: float, bz: float, cx: float, cz: float) -> int:
	var v: float = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
	if v > 1e-9:
		return 1
	if v < -1e-9:
		return -1
	return 0

static func _point_to_segment_dist(
	px: float, pz: float, ax: float, az: float, bx: float, bz: float,
) -> float:
	var dx: float = bx - ax
	var dz: float = bz - az
	var len_sq: float = dx * dx + dz * dz
	if len_sq < 1e-9:
		return sqrt((px - ax) * (px - ax) + (pz - az) * (pz - az))
	var t: float = ((px - ax) * dx + (pz - az) * dz) / len_sq
	t = clampf(t, 0.0, 1.0)
	var x: float = ax + dx * t
	var z: float = az + dz * t
	return sqrt((px - x) * (px - x) + (pz - z) * (pz - z))
