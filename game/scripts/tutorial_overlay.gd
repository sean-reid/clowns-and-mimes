extends CanvasLayer

## First-match onboarding. Shows a short sequence of hint cards, one at a time,
## each auto-advancing after STEP_SECONDS. Esc skips the rest. The overlay is
## click-through (Root ignores the mouse) so the player can actually move and
## shoot while reading — binding advance-on-click would steal the shoot input
## the very first hint tells them about.
##
## Sits below the in-game menu (layer 10) and settings (layer 20) so pausing
## covers it. Sets Settings.has_seen_tutorial when it finishes or is skipped.

signal finished

# Each step: textual hint + a normalized screen anchor for the card so a hint
# can sit near the UI it describes (item slot, minimap, sprint bar).
const STEPS := [
	{"text": "Click to shoot. There's a cooldown.", "anchor": Vector2(0.5, 0.82)},
	{"text": "Walk over items to pick one up. Press E to use it.", "anchor": Vector2(0.5, 0.82)},
	{"text": "Touch a frozen teammate to save them.", "anchor": Vector2(0.5, 0.82)},
	{"text": "The minimap shows your team. Some items reveal the enemy team.", "anchor": Vector2(0.62, 0.55)},
	{"text": "Last team standing wins. Watch your sprint meter.", "anchor": Vector2(0.32, 0.78)},
]
const STEP_SECONDS := 4.0
const FADE_SECONDS := 0.25

@onready var root: Control = $Root
@onready var card: PanelContainer = $Root/Card
@onready var hint: Label = $Root/Card/Margin/Box/Hint
@onready var counter: Label = $Root/Card/Margin/Box/Counter

var _index: int = 0
var _elapsed: float = 0.0

static func is_finished(index: int) -> bool:
	return index >= STEPS.size()

func _ready() -> void:
	_show_step(0)

func _process(delta: float) -> void:
	_elapsed += delta
	if _elapsed >= STEP_SECONDS:
		_advance()

func _unhandled_input(event: InputEvent) -> void:
	# Esc skips the whole sequence. Consume it so the same press doesn't also
	# pop the in-game menu open underneath us.
	if event.is_action_pressed("ui_cancel"):
		_finish()
		get_viewport().set_input_as_handled()

func _advance() -> void:
	_index += 1
	if is_finished(_index):
		_finish()
	else:
		_show_step(_index)

func _show_step(index: int) -> void:
	_elapsed = 0.0
	var step: Dictionary = STEPS[index]
	hint.text = String(step["text"])
	counter.text = "%d / %d" % [index + 1, STEPS.size()]
	_position_card(step["anchor"])
	card.modulate.a = 0.0
	var t := create_tween()
	t.tween_property(card, "modulate:a", 1.0, FADE_SECONDS)

func _position_card(anchor: Vector2) -> void:
	card.anchor_left = anchor.x
	card.anchor_right = anchor.x
	card.anchor_top = anchor.y
	card.anchor_bottom = anchor.y

func _finish() -> void:
	set_process(false)
	set_process_unhandled_input(false)
	Settings.set_has_seen_tutorial(true)
	finished.emit()
	var t := create_tween()
	t.tween_property(root, "modulate:a", 0.0, FADE_SECONDS)
	t.tween_callback(queue_free)
