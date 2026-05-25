extends CanvasLayer

## Heads-up display: sprint bar, countdown timer, team status, side event log,
## center frozen-overlay text.

@onready var sprint_bar: ProgressBar = $Margins/SprintBar
@onready var countdown_label: Label = $Margins/Countdown
@onready var team_status: HBoxContainer = $Margins/TeamStatus
@onready var event_log: VBoxContainer = $Margins/EventLog
@onready var team_badge: Label = $Margins/TeamBadge
@onready var topology_badge: Label = $Margins/TopologyBadge
@onready var frozen_overlay: Label = $FrozenOverlay
@onready var battle_cry_label: Label = $BattleCry
@onready var end_overlay: Control = $EndOverlay
@onready var end_label: Label = $EndOverlay/EndLabel

const MIME_COLOR := Color(0.95, 0.95, 0.95)
const CLOWN_COLOR := Color(0.95, 0.18, 0.22)
const MAX_LOG_LINES := 5

# Pre-allocated event-log Labels. append_log shifts text up through these
# instead of creating/destroying nodes. The old design spawned a Label per
# event with a 2.5s expiry coroutine; a burst of tag/save events compounded
# scene-tree mutations and redraw signal cascades that snowballed visibly.
var _log_lines: Array[Label] = []

func _ready() -> void:
	frozen_overlay.text = ""
	end_overlay.visible = false
	team_badge.text = ""
	topology_badge.text = ""
	battle_cry_label.text = ""
	battle_cry_label.modulate.a = 0.0
	_setup_log_lines()

func _setup_log_lines() -> void:
	# Remove any labels left over from the .tscn or from a previous run.
	for child in event_log.get_children():
		child.queue_free()
	_log_lines.clear()
	for i in MAX_LOG_LINES:
		var line := Label.new()
		line.text = ""
		event_log.add_child(line)
		_log_lines.append(line)
	_refresh_log_fade()

func set_topology(name: String) -> void:
	if name.is_empty():
		topology_badge.text = ""
		return
	# Pretty names per topology. "klein" alone is ambiguous; the full
	# "Klein Bottle" reads better. Everything else title-cases the wire name.
	var pretty: String
	if name == "klein":
		pretty = "Klein Bottle"
	else:
		pretty = name.substr(0, 1).to_upper() + name.substr(1)
	topology_badge.text = "on the %s" % pretty

func set_local_team(team: String) -> void:
	if team == "mime":
		team_badge.text = "you are a MIME"
		team_badge.modulate = MIME_COLOR
		sprint_bar.modulate = MIME_COLOR
	else:
		team_badge.text = "you are a CLOWN"
		team_badge.modulate = CLOWN_COLOR
		sprint_bar.modulate = CLOWN_COLOR

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
	# Shift each text up one slot and drop the new line into the bottom
	# (newest) slot. No node allocation or freeing per event, so a burst of
	# tag/save events stays at constant cost regardless of frequency.
	if _log_lines.size() < MAX_LOG_LINES:
		_setup_log_lines()
	for i in MAX_LOG_LINES - 1:
		_log_lines[i].text = _log_lines[i + 1].text
	_log_lines[MAX_LOG_LINES - 1].text = message
	_refresh_log_fade()

func _refresh_log_fade() -> void:
	# Fade older lines so the eye lands on the newest entry. Empty lines
	# are fully transparent; visible lines step down by 0.65 per row from
	# the newest at the bottom.
	for i in _log_lines.size():
		var age_from_newest: int = _log_lines.size() - 1 - i
		var line := _log_lines[i]
		if line.text.is_empty():
			line.modulate.a = 0.0
		else:
			line.modulate.a = maxf(0.15, pow(0.65, age_from_newest))

func flash_frozen(by_team: String, by_name: String) -> void:
	var verb := "mimed" if by_team == "mime" else "clowned"
	frozen_overlay.text = "you've been %s by %s!" % [verb, by_name]
	frozen_overlay.modulate.a = 1.0
	var tw := create_tween()
	tw.tween_property(frozen_overlay, "modulate:a", 0.0, 2.5)

func clear_frozen_overlay() -> void:
	frozen_overlay.text = ""

func flash_battle_cry(text: String, team: String) -> void:
	battle_cry_label.text = text
	battle_cry_label.modulate = Color(MIME_COLOR.r, MIME_COLOR.g, MIME_COLOR.b, 1.0) if team == "mime" else Color(CLOWN_COLOR.r, CLOWN_COLOR.g, CLOWN_COLOR.b, 1.0)
	var tw := create_tween()
	tw.tween_property(battle_cry_label, "modulate:a", 1.0, 0.15)
	tw.tween_interval(1.2)
	tw.tween_property(battle_cry_label, "modulate:a", 0.0, 0.6)

func show_end(victory: bool) -> void:
	end_label.text = "Victory!" if victory else "Failure."
	end_overlay.visible = true
