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

var frozen: bool = false:
	set(value):
		if frozen == value:
			return
		frozen = value
		_update_marker()
		frozen_changed.emit(frozen)

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

func _physics_process(delta: float) -> void:
	if frozen:
		velocity = Vector3.ZERO
		move_and_slide()
		_update_footsteps(0.0, false)
		return
	# Remote bodies (online humans and online bots) render from a fixed-delay
	# snapshot buffer; see _drive_remote_interp for the math. Footstep audio
	# rides the smoothed planar speed sampled in apply_remote_state.
	if _remote_armed and not is_local:
		_drive_remote_interp()
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
	move_and_slide()
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
	move_and_slide()
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
		global_position = pos
		rotation.y = yaw
		_remote_armed = true
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
		global_position = oldest["pos"]
		rotation.y = float(oldest["yaw"])
		return
	if older_index >= _remote_buffer.size() - 1:
		# render_t is past the latest snapshot - hold rather than extrapolating
		# blindly. A few late ticks of network delay will resolve themselves
		# when the next snapshot arrives.
		var latest: Dictionary = _remote_buffer[_remote_buffer.size() - 1]
		global_position = latest["pos"]
		rotation.y = float(latest["yaw"])
		return
	var a: Dictionary = _remote_buffer[older_index]
	var b: Dictionary = _remote_buffer[older_index + 1]
	var a_pos: Vector3 = a["pos"]
	var b_pos: Vector3 = b["pos"]
	if (b_pos - a_pos).length() > REMOTE_WRAP_THRESHOLD:
		# Topology seam crossing or server teleport - snap to the newer side
		# instead of lerping across the playfield.
		global_position = b_pos
		rotation.y = float(b["yaw"])
		return
	var span: float = float(b["t"]) - float(a["t"])
	var alpha: float = 0.0 if span <= 1e-6 else clampf((render_t - float(a["t"])) / span, 0.0, 1.0)
	global_position = a_pos.lerp(b_pos, alpha)
	rotation.y = lerp_angle(float(a["yaw"]), float(b["yaw"]), alpha)

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
