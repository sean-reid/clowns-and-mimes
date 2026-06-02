extends Node

## Persists the OS window's size + position across launches. On the very first
## launch (nothing saved) the window fills the screen; afterwards it reopens at
## the size / position the player last left it. State lives in Settings, so the
## "Reset settings" button clears it and the next launch fills the screen again.
##
## Instantiated by main.gd as a child of the persistent root, so it outlives
## every screen swap and still receives the window-close notification.

# A drag-resize fires size_changed every frame; wait for it to settle before
# touching the config file.
const SAVE_DEBOUNCE_S := 0.6

var _window: Window = null
var _save_timer: Timer = null

func _ready() -> void:
	# No real window under the headless server (CI / tools); nothing to size.
	if DisplayServer.get_name() == "headless":
		return
	_window = get_window()
	_apply_initial_geometry()
	_save_timer = Timer.new()
	_save_timer.one_shot = true
	_save_timer.wait_time = SAVE_DEBOUNCE_S
	_save_timer.timeout.connect(_persist)
	add_child(_save_timer)
	_window.size_changed.connect(func() -> void: _save_timer.start())

func _apply_initial_geometry() -> void:
	# First launch: no saved size -> fill the screen.
	if Settings.window_size == Vector2i.ZERO:
		_window.mode = Window.MODE_MAXIMIZED
		return
	# Returning player who left it maximized: maximize again.
	if Settings.window_maximized:
		_window.mode = Window.MODE_MAXIMIZED
		return
	# Otherwise restore the exact windowed size, clamping the position back onto
	# a screen in case the monitor it was last on is gone.
	_window.mode = Window.MODE_WINDOWED
	_window.size = Settings.window_size
	_window.position = _clamp_to_screen(Settings.window_position, Settings.window_size)

func _persist() -> void:
	if _window == null:
		return
	var maximized: bool = _window.mode == Window.MODE_MAXIMIZED
	if maximized:
		# Keep the last windowed size/position (a maximized window reports the
		# full-screen rect, which we never want to restore as a windowed size);
		# just remember that we exited maximized.
		Settings.set_window_geometry(Settings.window_size, Settings.window_position, true)
	else:
		Settings.set_window_geometry(_window.size, _window.position, false)

# Keep the window on a visible screen: a saved position can land off-screen when
# a monitor is unplugged. Clamp so the whole window fits within the usable rect.
func _clamp_to_screen(pos: Vector2i, size: Vector2i) -> Vector2i:
	var rect: Rect2i = DisplayServer.screen_get_usable_rect(DisplayServer.get_primary_screen())
	var max_x: int = rect.position.x + maxi(0, rect.size.x - size.x)
	var max_y: int = rect.position.y + maxi(0, rect.size.y - size.y)
	return Vector2i(
		clampi(pos.x, rect.position.x, max_x),
		clampi(pos.y, rect.position.y, max_y),
	)

func _notification(what: int) -> void:
	# Flush on quit so the final geometry is captured even if the debounce timer
	# has not fired yet.
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_persist()
