extends CanvasLayer

## In-game menu overlay. Opened by Esc during play. The world keeps running
## while it is open - the game does not pause - so the player remains
## vulnerable to opponents until they resume. Offers Resume and Quit to main
## menu. A future revision will also add Settings and Disconnect.

signal resume_requested
signal quit_to_menu_requested

@onready var resume_button: Button = $Content/Resume
@onready var quit_button: Button = $Content/Quit

func _ready() -> void:
	visible = false
	resume_button.pressed.connect(_on_resume)
	quit_button.pressed.connect(_on_quit)

func open() -> void:
	visible = true
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	resume_button.grab_focus()

func close() -> void:
	visible = false
	Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)

func _input(event: InputEvent) -> void:
	if not visible:
		return
	if event.is_action_pressed("ui_pause"):
		_on_resume()
		get_viewport().set_input_as_handled()

func _on_resume() -> void:
	resume_requested.emit()

func _on_quit() -> void:
	quit_to_menu_requested.emit()
