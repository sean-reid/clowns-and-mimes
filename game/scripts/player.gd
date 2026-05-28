extends CharacterBody3D

## Local or remote player. WASD + mouse + sprint for the local one, network or
## bot inputs drive remote bodies. While frozen, the body cannot move (velocity
## is held at zero) but mouse look stays active so the player can watch the
## round play out around them. A small floating exclamation marker is rendered
## above the head for everyone except the player themselves.

signal sprint_changed(value: float)
signal frozen_changed(frozen: bool)

const MARKER := preload("res://scenes/exclamation_marker.tscn")
const AssetPaths := preload("res://scripts/asset_paths.gd")
const WALK_SPEED := 3.2
const SPRINT_SPEED := 5.6
const MAX_SPRINT := 100.0
const SPRINT_DRAIN_PER_S := 25.0
const SPRINT_REGEN_PER_S := 15.0
const LOOK_SENSITIVITY := 0.0025

@export var team: String = "mime"
@export var bot: bool = false
@export var is_local: bool = true
@export var display_name: String = ""
# When true, arena.gd drives this body's X/Z position via the shared movement
# predictor instead of player.gd reading input directly. Mirrors what the
# server is computing, so the position the server sees matches what the
# client predicts.
var predicted_externally: bool = false
var _external_planar_speed: float = 0.0
var _external_sprinting: bool = false

var sprint_energy: float = MAX_SPRINT:
	set(value):
		sprint_energy = clampf(value, 0.0, MAX_SPRINT)
		sprint_changed.emit(sprint_energy)

## Driven by BotAI for bot players. Direction is in world space, length up to 1.
var bot_intent: Vector3 = Vector3.ZERO
var bot_sprint: bool = false
# Rising-edge jump request for bot bodies in offline mode. bot_ai.gd flips
# this true on the tick its 3-trigger predicate fires; _apply_bot_movement
# consumes it (passes to Physics.step_jump) and resets it to false. Online
# bot jumps are server-driven so this stays unused for online bodies.
var bot_jump: bool = false

var frozen: bool = false:
	set(value):
		if frozen == value:
			return
		frozen = value
		_update_marker()
		frozen_changed.emit(frozen)
		# Cancel any active jump arc. After this point Physics.jump_arc_y
		# returns HOVER_HEIGHT, and the smooth descent below interpolates
		# the rendered Y from where the body was caught down to hover so
		# the tagged jumper drifts back to the float position instead of
		# teleporting.
		if frozen:
			jump_started_at_ms = -1
		# Seed the Y-ramp used in _process for any body whose Y the arena's
		# online predictor doesn't own. That covers offline-local,
		# offline-bots, AND online remote bodies on this client - all paths
		# where player.gd writes its own Y. The online local body is gated
		# out via predicted_externally because arena.gd::_advance_local_prediction
		# runs its own ramp for it.
		if frozen and not predicted_externally:
			if global_position.y > PhysicsScript.HOVER_HEIGHT + 0.001:
				_frozen_descent_y = global_position.y
		elif not frozen:
			_frozen_descent_y = PhysicsScript.HOVER_HEIGHT

@onready var camera: Camera3D = $Camera
@onready var head: MeshInstance3D = $Head

var marker_instance: Node3D = null
var footstep_player: AudioStreamPlayer3D = null

# Remote players never have velocity written. apply_remote_state only sets
# global_position, so velocity stays at zero and _update_footsteps keeps the
# volume curve muted. Track the delta between consecutive remote updates to
# derive an effective planar speed for the spatial footstep audio. Without
# this, remote players walked silent.
var _last_remote_position: Vector3 = Vector3.ZERO
var _last_remote_time_s: float = 0.0
var _remote_planar_speed: float = 0.0

# Remote-position rendering uses a fixed-delay snapshot buffer (the Quake /
# Source / Overwatch "entity interpolation" pattern). Each apply_remote_state
# appends (timestamp, position, yaw) to _remote_buffer. _drive_remote_interp
# renders the body at `now - REMOTE_RENDER_DELAY_S`, interpolating between the
# two snapshots that bracket that virtual time. Because we always have at
# least one future snapshot relative to the rendered time, network jitter up
# to the buffer size is invisible: late packets just shrink the buffer, they
# do not stall or snap the body.
const REMOTE_RENDER_DELAY_S := 0.1
const REMOTE_BUFFER_MAX_AGE_S := 0.5
# Threshold for detecting a topology seam crossing between two snapshots. A
# single tick at sprint speed travels ~0.1 m, so anything past 1 m must be a
# wrap (or a server-side teleport). Skip interpolation and snap to the newer
# side rather than lerping through the playfield.
const REMOTE_WRAP_THRESHOLD := 1.0
var _remote_buffer: Array[Dictionary] = []
var _remote_armed: bool = false
# Optional back-reference to the arena, set by arena._spawn_player. Used
# by _to_camera_nearest_copy to render this body at the wrap-equivalent
# position closest to the local camera (so a bot whose server position
# just wrapped from z=+39 to z=-39 appears at z=+41 in the local
# player's frame rather than visibly teleporting 80 m away). Null on
# offline scenes / tests / the local body itself.
var arena: Node = null

# Authoritative jumpStartedAt for THIS body (Unix ms). -1 means "not
# jumping". For the local body arena.gd writes the predictor's value
# each frame; for remote bodies apply_remote_state pulls it from the
# server's PlayerState. Drives the squash-and-stretch curve via
# _apply_jump_squash(), and signals the same arc helper that owns Y
# position so animation and Y stay in lockstep.
var jump_started_at_ms: int = -1
# Rising-edge tracker for the local player's spacebar in offline mode.
# Online holds the same state in arena.gd::_jump_was_held because the
# predictor builds the input frame from there; offline-local manages its
# own copy here so holding Space sends exactly one jump instead of one
# per physics tick. Unused for online local + remote bodies.
var _jump_was_held_offline: bool = false
# Cached scale applied to the head mesh each frame. Lerped back to
# Vector3.ONE over SQUASH_RECOVER_S when no jump is active so the
# transition out of a jump doesn't pop. Stored on the node so the
# recovery survives even when the arc ends mid-frame.
var _head_squash_scale: Vector3 = Vector3.ONE
const SQUASH_RECOVER_S := 0.15
const PhysicsScript := preload("res://scripts/physics.gd")

# Remote body's current Y while drifting down from a mid-jump freeze.
# Seeded in the `frozen` setter on the false→true transition for non-local
# bodies; decremented at 5 m/s in _process until it reaches HOVER_HEIGHT.
# Sits at HOVER_HEIGHT outside the descent window so the if-check in
# _process is a cheap no-op for grounded frozen bodies.
var _frozen_descent_y: float = PhysicsScript.HOVER_HEIGHT

func _ready() -> void:
	if is_local and not bot:
		Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)
	if not is_local:
		camera.queue_free()
	_apply_head_texture()
	_setup_footsteps()

func _setup_footsteps() -> void:
	var stream: AudioStream = AssetPaths.try_load_audio(AssetPaths.FOOTSTEPS)
	if stream == null:
		return
	if stream is AudioStreamMP3:
		(stream as AudioStreamMP3).loop = true
	footstep_player = AudioStreamPlayer3D.new()
	footstep_player.stream = stream
	footstep_player.bus = "SFX"
	footstep_player.unit_size = 8.0
	footstep_player.max_db = 0.0 if is_local else -6.0
	footstep_player.volume_db = -80.0
	add_child(footstep_player)
	footstep_player.play()

const HEAD_SHADER := preload("res://shaders/avatar_head.gdshader")
const MIME_BACK_COLOR := Color(0.10, 0.14, 0.40)
const CLOWN_BACK_COLOR := Color(0.30, 0.05, 0.10)

func _apply_head_texture() -> void:
	if head == null:
		return
	var texture: Texture2D = AssetPaths.try_load_texture(team)
	# Shader splits the sphere: face texture on the front hemisphere, dark
	# team color on the back. Mime back is dark blue, clown back is dark red.
	# The shader handles a null face_texture by falling back to a uniform-
	# colored front, but in practice we always have textures imported.
	var mat := ShaderMaterial.new()
	mat.shader = HEAD_SHADER
	mat.set_shader_parameter("back_color", CLOWN_BACK_COLOR if team == "clown" else MIME_BACK_COLOR)
	if texture != null:
		mat.set_shader_parameter("face_texture", texture)
	head.material_override = mat

func _input(event: InputEvent) -> void:
	if bot or not is_local:
		return
	# Mouse look stays available while frozen so the player can watch their
	# team play around them. Movement input is gated separately in
	# _physics_process; the frozen branch there holds velocity at zero.
	if event is InputEventMouseMotion and Input.get_mouse_mode() == Input.MOUSE_MODE_CAPTURED:
		rotate_y(-event.relative.x * LOOK_SENSITIVITY)
		camera.rotate_x(-event.relative.y * LOOK_SENSITIVITY)
		camera.rotation.x = clampf(camera.rotation.x, -1.2, 1.2)

func _process(delta: float) -> void:
	# Remote-body position update at render rate. Previously this lived in
	# _physics_process at 60 Hz, but the lerp is purely visual (no
	# collision interaction, no move_and_slide), and on a high-refresh-rate
	# monitor (144 Hz+) the body's rendered position would only refresh
	# every second or third frame, producing a sawtooth stutter that read
	# as "bots are jittery." Running it from _process closes the gap to
	# the monitor's actual refresh rate. The local player has always had
	# this treatment via arena.gd's _advance_local_prediction, which is
	# why local motion is smooth and remote bodies stuttered.
	if _remote_armed and not is_local:
		_drive_remote_interp()
	# Frozen-mid-jump descent. Applied to any body whose Y is above hover
	# and whose Y isn't owned by the online predictor. That covers offline
	# local + offline bots + online remote bodies on this client. Online
	# local is gated out via predicted_externally because
	# arena.gd::_advance_local_prediction runs its own ramp for it.
	# Without this override the body would sit at peak (remote interp
	# would write the snapshot Y for ~16 ms then freeze, offline bodies
	# would never move Y at all).
	if frozen and not predicted_externally and _frozen_descent_y > PhysicsScript.HOVER_HEIGHT + 0.001:
		_frozen_descent_y = maxf(
			PhysicsScript.HOVER_HEIGHT,
			_frozen_descent_y - 5.0 * delta,
		)
		global_position = Vector3(
			global_position.x,
			_frozen_descent_y,
			global_position.z,
		)
	# Squash-and-stretch driven by jumpStartedAt. Runs for every body
	# (local + remote) so jumping reads consistently across all
	# observers. _delta is the render frame dt, used to ease the
	# recovery scale back to identity after a jump ends.
	_apply_jump_squash(delta)

func _physics_process(delta: float) -> void:
	if frozen:
		velocity = Vector3.ZERO
		move_and_slide()
		_update_footsteps(0.0, false)
		return
	# Remote bodies (online humans and online bots): position is owned by
	# _process now (see comment there). This branch only drives the
	# footstep audio at the physics rate.
	if _remote_armed and not is_local:
		_update_footsteps(_remote_planar_speed, false)
		return
	if bot:
		_apply_bot_movement(delta)
		return
	if not is_local:
		# Remote body without a snapshot yet (joined this frame). Hold still.
		_update_footsteps(0.0, false)
		return
	# Online local player: arena.gd's reconciler owns the X/Z position via the
	# shared movement step. Run move_and_slide with zero velocity so the body
	# settles under gravity but doesn't double-walk on the input axes.
	if predicted_externally:
		velocity = Vector3.ZERO
		move_and_slide()
		_update_footsteps(_external_planar_speed, _external_sprinting)
		return
	# The in-game menu releases the mouse cursor when open. Use that as the
	# signal that the local player should not be reading input. The world
	# keeps running, but the character stands still.
	if Input.get_mouse_mode() != Input.MOUSE_MODE_CAPTURED:
		velocity = Vector3.ZERO
		move_and_slide()
		_update_footsteps(0.0, false)
		return
	var input_dir := Vector3.ZERO
	input_dir.z -= Input.get_action_strength("move_forward")
	input_dir.z += Input.get_action_strength("move_back")
	input_dir.x -= Input.get_action_strength("move_left")
	input_dir.x += Input.get_action_strength("move_right")
	input_dir = input_dir.normalized()
	var sprinting := Input.is_action_pressed("sprint") and sprint_energy > 0.0 and input_dir.length() > 0.0
	var speed := SPRINT_SPEED if sprinting else WALK_SPEED
	var basis_dir := transform.basis * input_dir
	velocity.x = basis_dir.x * speed
	velocity.z = basis_dir.z * speed
	# Rising-edge spacebar so a held key sends one jump, not 60. Online holds
	# the same edge in arena.gd::_jump_was_held; the predictor builds its
	# input frame from there. Offline-local runs Physics.step_jump itself
	# so the arc behaves identically to the online server's authoritative path.
	var jump_pressed: bool = Input.is_action_pressed("jump")
	var jump_edge: bool = jump_pressed and not _jump_was_held_offline
	_jump_was_held_offline = jump_pressed
	var now_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	jump_started_at_ms = PhysicsScript.step_jump(jump_started_at_ms, jump_edge, now_ms)
	move_and_slide()
	# Apply arc Y after move_and_slide so the slide pass doesn't shave the
	# body's altitude. The arc is deterministic - same math as the server
	# in advanceIdleJumpState - so Y at any moment is purely a function of
	# jump_started_at_ms and now_ms.
	global_position.y = PhysicsScript.jump_arc_y(jump_started_at_ms, now_ms)
	if sprinting:
		sprint_energy -= SPRINT_DRAIN_PER_S * delta
	else:
		sprint_energy += SPRINT_REGEN_PER_S * delta
	_update_footsteps(Vector2(velocity.x, velocity.z).length(), sprinting)

func _apply_bot_movement(delta: float) -> void:
	var intent := bot_intent
	if intent.length() > 1.0:
		intent = intent.normalized()
	var sprinting := bot_sprint and sprint_energy > 0.0 and intent.length() > 0.0
	var speed := SPRINT_SPEED if sprinting else WALK_SPEED
	velocity.x = intent.x * speed
	velocity.z = intent.z * speed
	if intent.length() > 0.01:
		var target_yaw := atan2(-intent.x, -intent.z)
		rotation.y = lerp_angle(rotation.y, target_yaw, clampf(8.0 * delta, 0.0, 1.0))
	# Consume the bot's rising-edge jump request. bot_ai.gd flips bot_jump
	# true for one tick when its 3-trigger predicate fires; resetting here
	# prevents step_jump from re-firing every physics tick. Same arc math
	# as the local player and the server's bot path.
	var jump_request: bool = bot_jump
	bot_jump = false
	var now_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	jump_started_at_ms = PhysicsScript.step_jump(jump_started_at_ms, jump_request, now_ms)
	move_and_slide()
	global_position.y = PhysicsScript.jump_arc_y(jump_started_at_ms, now_ms)
	if sprinting:
		sprint_energy -= SPRINT_DRAIN_PER_S * delta
	else:
		sprint_energy += SPRINT_REGEN_PER_S * delta
	_update_footsteps(Vector2(velocity.x, velocity.z).length(), sprinting)

func set_external_motion(planar_speed: float, sprinting: bool) -> void:
	_external_planar_speed = planar_speed
	_external_sprinting = sprinting

func _update_footsteps(planar_speed: float, sprinting: bool) -> void:
	if footstep_player == null:
		return
	if planar_speed < 0.2:
		footstep_player.volume_db = -80.0
		footstep_player.pitch_scale = 1.0
		return
	footstep_player.volume_db = (0.0 if is_local else -8.0)
	# Pitch scales with speed: walk = 1.0, sprint = ~1.4. Pitch range clamped so
	# pause doesn't audibly chirp during deceleration.
	var ratio: float = clampf(planar_speed / WALK_SPEED, 0.85, 1.5)
	footstep_player.pitch_scale = ratio
	if sprinting:
		footstep_player.pitch_scale = clampf(planar_speed / WALK_SPEED, 1.2, 1.6)

func apply_remote_state(pos: Vector3, yaw: float, is_frozen: bool, sprint: float) -> void:
	# Derive an effective planar speed from the delta between snapshots so the
	# footstep audio has something to drive its volume curve. The first call
	# initialises the trackers without producing a phantom speed value.
	var now_s: float = Time.get_unix_time_from_system()
	if _last_remote_time_s > 0.0:
		var dt: float = now_s - _last_remote_time_s
		if dt > 1e-3:
			var planar: Vector2 = Vector2(pos.x - _last_remote_position.x, pos.z - _last_remote_position.z)
			# Lerp toward the new sample to ride out the per-snapshot jitter
			# without lagging significantly behind real movement.
			var sample: float = planar.length() / dt
			_remote_planar_speed = lerpf(_remote_planar_speed, sample, 0.5)
	_last_remote_position = pos
	_last_remote_time_s = now_s
	# First snapshot snaps the body directly to pos so it doesn't lerp from
	# the origin. Subsequent snapshots feed the interpolation buffer.
	if not _remote_armed:
		global_position = _to_camera_nearest_copy(pos)
		rotation.y = yaw
		_remote_armed = true
	# Append the SERVER-authoritative position to the buffer. The lerp /
	# snap in _drive_remote_interp will translate it into the camera-near
	# copy before writing global_position, so the buffer always stores
	# the canonical wrapped position (no need to refresh entries as the
	# local camera moves).
	_remote_buffer.append({"t": now_s, "pos": pos, "yaw": yaw})
	# Drop entries older than the buffer window. Always keep at least two so
	# _drive_remote_interp has a bracketing pair even when the player has not
	# moved for a while.
	var cutoff: float = now_s - REMOTE_BUFFER_MAX_AGE_S
	while _remote_buffer.size() > 2 and float(_remote_buffer[0]["t"]) < cutoff:
		_remote_buffer.pop_front()
	frozen = is_frozen
	sprint_energy = sprint
	# Don't call settle_into_world here anymore: the body is no longer being
	# slammed to pos every snapshot. _physics_process slides it through the
	# interpolated positions and handles depenetration as part of move_and_slide.

# CharacterBody3D does not auto-resolve overlaps when global_position is set
# directly (spawn, topology wrap, apply_remote_state). Running move_and_slide
# with zero velocity invokes the physics solver's recovery pass, which pushes
# the body out of any wall it ended up inside. Cheap enough to call after
# every direct write.
func settle_into_world() -> void:
	var prior := velocity
	velocity = Vector3.ZERO
	move_and_slide()
	velocity = prior

# Render the remote body at `now - REMOTE_RENDER_DELAY_S` by interpolating
# between the two buffered snapshots that bracket that virtual time. The
# delay guarantees we have at least one future snapshot relative to render
# time, so jitter inside the buffer window never produces a stall or a snap.
# If render_t falls outside the buffer (rare: connection hiccup longer than
# REMOTE_BUFFER_MAX_AGE_S, or the very first snapshot just arrived), hold at
# the nearest edge instead of extrapolating into thin air.
func _drive_remote_interp() -> void:
	if _remote_buffer.is_empty():
		return
	var render_t: float = Time.get_unix_time_from_system() - REMOTE_RENDER_DELAY_S
	# Locate the latest snapshot with t <= render_t; the snapshot at
	# older_index + 1 (if it exists) is the future bracket.
	var older_index: int = -1
	for i in range(_remote_buffer.size() - 1, -1, -1):
		if float(_remote_buffer[i]["t"]) <= render_t:
			older_index = i
			break
	if older_index < 0:
		# render_t is before any buffered snapshot - hold at the oldest entry.
		var oldest: Dictionary = _remote_buffer[0]
		global_position = _to_camera_nearest_copy(oldest["pos"])
		rotation.y = float(oldest["yaw"])
		return
	if older_index >= _remote_buffer.size() - 1:
		# render_t is past the latest snapshot - hold rather than extrapolating
		# blindly. A few late ticks of network delay will resolve themselves
		# when the next snapshot arrives.
		var latest: Dictionary = _remote_buffer[_remote_buffer.size() - 1]
		global_position = _to_camera_nearest_copy(latest["pos"])
		rotation.y = float(latest["yaw"])
		return
	var a: Dictionary = _remote_buffer[older_index]
	var b: Dictionary = _remote_buffer[older_index + 1]
	var a_pos: Vector3 = a["pos"]
	var b_pos: Vector3 = b["pos"]
	if (b_pos - a_pos).length() > REMOTE_WRAP_THRESHOLD:
		# Topology seam crossing or server teleport. The naive lerp would
		# blend through the middle of the playfield, so skip it and render
		# the body at the wrap-nearest copy of the newer position relative
		# to the local camera - the body appears to continue past the seam
		# instead of teleporting across the world.
		global_position = _to_camera_nearest_copy(b_pos)
		rotation.y = float(b["yaw"])
		return
	var span: float = float(b["t"]) - float(a["t"])
	var alpha: float = 0.0 if span <= 1e-6 else clampf((render_t - float(a["t"])) / span, 0.0, 1.0)
	global_position = _to_camera_nearest_copy(a_pos.lerp(b_pos, alpha))
	rotation.y = lerp_angle(float(a["yaw"]), float(b["yaw"]), alpha)

# Translate a server-authoritative canonical position into the
# wrap-equivalent copy nearest the local player's camera. On the plane
# (or when arena/topology refs are not wired) this is a no-op. On wrap
# topologies (torus, möbius, klein) this is what keeps a bot whose
# canonical position just wrapped from z=+39 to z=-39 visible at z=+41
# instead of teleporting 80 m away from the camera.
#
# Y is preserved from the canonical position verbatim. Topology delta
# zeroes Y (wrapping is planar), so a naive `camera_pos + delta` would
# inherit the camera's Y - which made every remote body visibly rise
# whenever the local player jumped. Compose XZ from the camera-relative
# wrap and keep canonical.y untouched.
func _to_camera_nearest_copy(canonical: Vector3) -> Vector3:
	if arena == null:
		return canonical
	var topology: Object = arena.topology
	if topology == null:
		return canonical
	var local: Node = arena.local_player
	if local == null:
		return canonical
	var camera_pos: Vector3 = local.global_position
	var planar_offset: Vector3 = topology.delta(camera_pos, canonical)
	return Vector3(
		camera_pos.x + planar_offset.x,
		canonical.y,
		camera_pos.z + planar_offset.z,
	)

func _update_marker() -> void:
	# Local player should not see their own marker even while frozen.
	if is_local:
		return
	if frozen and marker_instance == null:
		marker_instance = MARKER.instantiate()
		add_child(marker_instance)
		marker_instance.position = Vector3(0.0, 1.9, 0.0)
	elif not frozen and marker_instance != null:
		marker_instance.queue_free()
		marker_instance = null

# Disney bouncing-ball squash + stretch driven by jumpStartedAt.
# Returns a scale applied to the head mesh each render frame.
#
# Curve key poses (normalized progress t in [0, 1] across the arc):
#   anticipation squash  t < 0.10: wide + short
#   stretch upward       t < 0.40: tall + thin
#   peak compression     t < 0.60: slightly squashed at apex
#   stretch downward     t < 0.90: tall + thin (returning)
#   landing squash       t < 1.00: wide + short
# Smoothstep eases between consecutive poses so the deformation reads
# without snapping. Outside the arc window the cached scale lerps back
# to identity over SQUASH_RECOVER_S.
const _SQUASH_KEYFRAMES: Array = [
	[0.00, Vector2(1.2, 0.7)],
	[0.10, Vector2(0.85, 1.3)],
	[0.40, Vector2(1.1, 0.85)],
	[0.60, Vector2(0.85, 1.3)],
	[0.90, Vector2(1.2, 0.7)],
	[1.00, Vector2(1.0, 1.0)],
]

func _apply_jump_squash(delta_s: float) -> void:
	if head == null:
		return
	var target: Vector3 = _compute_jump_squash_target()
	if target == Vector3.ONE:
		# Not jumping (or arc ended). Recover to identity over a short
		# window so the head doesn't pop back to neutral scale at the
		# end of the arc.
		var lerp_t: float = clampf(delta_s / SQUASH_RECOVER_S, 0.0, 1.0)
		_head_squash_scale = _head_squash_scale.lerp(Vector3.ONE, lerp_t)
	else:
		# Mid-arc: snap to the computed scale. The curve itself is
		# already smooth (smoothstep between keyframes), so an extra
		# lerp here would lag the silhouette behind the position.
		_head_squash_scale = target
	head.scale = _head_squash_scale

func _compute_jump_squash_target() -> Vector3:
	if jump_started_at_ms < 0:
		return Vector3.ONE
	var now_ms: int = int(Time.get_unix_time_from_system() * 1000.0)
	var duration_ms: int = int(PhysicsScript.JUMP_DURATION_S * 1000.0)
	var elapsed_ms: int = now_ms - jump_started_at_ms
	if elapsed_ms < 0 or elapsed_ms >= duration_ms:
		return Vector3.ONE
	var t: float = float(elapsed_ms) / float(duration_ms)
	# Find the bracketing pair of keyframes around t.
	for i in range(_SQUASH_KEYFRAMES.size() - 1):
		var a: Array = _SQUASH_KEYFRAMES[i]
		var b: Array = _SQUASH_KEYFRAMES[i + 1]
		var t_a: float = float(a[0])
		var t_b: float = float(b[0])
		if t < t_b:
			var span: float = t_b - t_a
			var local_t: float = 0.0 if span <= 1e-6 else (t - t_a) / span
			var smooth_t: float = smoothstep(0.0, 1.0, local_t)
			var scale_a: Vector2 = a[1]
			var scale_b: Vector2 = b[1]
			var xz: float = lerpf(scale_a.x, scale_b.x, smooth_t)
			var y: float = lerpf(scale_a.y, scale_b.y, smooth_t)
			return Vector3(xz, y, xz)
	return Vector3.ONE
