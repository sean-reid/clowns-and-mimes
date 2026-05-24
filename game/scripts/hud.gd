extends CanvasLayer

## Heads-up display: sprint bar, countdown timer, team status, side event log,
## center frozen-overlay text.

@onready var sprint_bar: ProgressBar = $Margins/SprintBar
@onready var countdown_label: Label = $Margins/Countdown
@onready var team_status: HBoxContainer = $Margins/TeamStatus
@onready var event_log: VBoxContainer = $Margins/EventLog
@onready var frozen_overlay: Label = $FrozenOverlay
@onready var end_overlay: Control = $EndOverlay
@onready var end_label: Label = $EndOverlay/EndLabel

func _ready() -> void:
	frozen_overlay.text = ""
	end_overlay.visible = false

func set_sprint(value: float) -> void:
	sprint_bar.value = value

func set_countdown_seconds(seconds: float) -> void:
	if seconds < 0.0:
		countdown_label.text = ""
		return
	if seconds >= 60.0:
		var m: int = int(floor(seconds / 60.0))
		var s: int = int(seconds) % 60
		countdown_label.text = "%d:%02d" % [m, s]
	else:
		countdown_label.text = "%d" % int(ceil(seconds))

func render_team_status(players: Array) -> void:
	for child in team_status.get_children():
		child.queue_free()
	for player in players:
		var icon := ColorRect.new()
		icon.custom_minimum_size = Vector2(20, 20)
		var clown_team: bool = player.get("team") == "clown"
		var frozen: bool = bool(player.get("frozen"))
		icon.color = Color(0.9, 0.2, 0.22) if clown_team else Color(0.95, 0.95, 0.95)
		icon.modulate.a = 0.35 if frozen else 1.0
		team_status.add_child(icon)

func append_log(message: String) -> void:
	var line := Label.new()
	line.text = message
	event_log.add_child(line)
	get_tree().create_timer(4.0).timeout.connect(func():
		if is_instance_valid(line):
			line.queue_free())

func flash_frozen(by_team: String, by_name: String) -> void:
	var verb := "mimed" if by_team == "mime" else "clowned"
	frozen_overlay.text = "you've been %s by %s!" % [verb, by_name]
	frozen_overlay.modulate.a = 1.0
	var tw := create_tween()
	tw.tween_property(frozen_overlay, "modulate:a", 0.0, 2.5)

func clear_frozen_overlay() -> void:
	frozen_overlay.text = ""

func show_end(victory: bool) -> void:
	end_label.text = "Victory!" if victory else "Failure."
	end_overlay.visible = true
