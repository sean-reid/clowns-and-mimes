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

func _apply_head_texture() -> void:
	var texture: Texture2D = AssetPaths.try_load_texture(team)
	if texture == null or head == null:
		return
	var mat := StandardMaterial3D.new()
	mat.albedo_texture = texture
	mat.albedo_color = Color.WHITE
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
	if bot:
		_apply_bot_movement(delta)
		return
	if not is_local:
		_update_footsteps(_remote_planar_speed, false)
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
	global_position = pos
	rotation.y = yaw
	frozen = is_frozen
	sprint_energy = sprint
	settle_into_world()

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
