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

# Team palette for HUD elements (team badge, sprint bar tint, battle cry
# label, status icons). Used everywhere in this file that needs to draw
# a player in their team color. player.gd has its own darker BACK colors
# for the avatar mesh - those are intentionally different (different
# visual role) and stay local.
const MIME_COLOR := Color(0.95, 0.95, 0.95)
const CLOWN_COLOR := Color(0.95, 0.18, 0.22)
const MAX_LOG_LINES := 5

# Upper bound on the team-status icon pool. 3 bots/team * 2 teams +
# 4 humans + headroom = 10; round up to 20 so adding a team mode
# or temporarily oversized rosters never overflows.
const MAX_TEAM_ICONS := 20
const ICON_SIZE := Vector2(20, 20)
const ICON_ALPHA_FROZEN := 0.35
const ICON_ALPHA_ACTIVE := 1.0

# Side event-log fade curve. Each older line steps down by FADE_BASE per
# row from the newest; cap at FADE_MIN so the oldest still reads.
const LOG_FADE_BASE := 0.65
const LOG_FADE_MIN := 0.15

# Centered overlay timing. flash_frozen lingers the longest because the
# player is reading "you've been mimed by Alice" mid-game; battle cry
# and disperse fade out quickly so they don't block sight lines.
const FROZEN_FLASH_FADE_S := 2.5
const BATTLE_CRY_FADE_IN_S := 0.15
const BATTLE_CRY_HOLD_S := 1.2
const BATTLE_CRY_FADE_OUT_S := 0.6
const DISPERSE_HOLD_S := 1.6
const DISPERSE_FADE_OUT_S := 0.6

# Sub-millisecond positive countdown values still float into the
# label and read as "0" - guard with a small epsilon.
const COUNTDOWN_BLANK_EPSILON := 0.001

# Pre-allocated event-log Labels. append_log shifts text up through these
# instead of creating/destroying nodes. The old design spawned a Label per
# event with a 2.5s expiry coroutine; a burst of tag/save events compounded
# scene-tree mutations and redraw signal cascades that snowballed visibly.
var _log_lines: Array[Label] = []

# Pre-allocated team-status icons. render_team_status flips visibility and
# rewrites color/alpha on the first N instead of queue_freeing the old set
# and instantiating a new one each delta. Same lesson as the event log:
# per-event node churn at 60Hz triggers signal cascades that visibly stall
# the editor and clients.
var _team_icons: Array[ColorRect] = []

func _ready() -> void:
	frozen_overlay.text = ""
	end_overlay.visible = false
	team_badge.text = ""
	topology_badge.text = ""
	battle_cry_label.text = ""
	battle_cry_label.modulate.a = 0.0
	_setup_log_lines()
	_setup_team_icons()

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
	# Pretty names per topology. "klein" -> "Klein Bottle", "mobius" ->
	# "Möbius Strip" with the umlaut.
	var pretty: String
	if name == "klein":
		pretty = "Klein Bottle"
	elif name == "mobius":
		pretty = "Möbius Strip"
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
	# Negative is the explicit "no countdown" sentinel. Zero (or sub-millisecond
	# values) lands here whenever the active phase has no turn-end time set
	# yet - during the filling phase before the match starts, or for one frame
	# at the boundary where a turn just expired and the next phase update is
	# in flight. In both cases rendering "0" looks like a stuck countdown, so
	# blank the label instead.
	if seconds <= COUNTDOWN_BLANK_EPSILON:
		countdown_label.text = ""
		return
	if seconds >= 60.0:
		var m: int = int(floor(seconds / 60.0))
		var s: int = int(seconds) % 60
		countdown_label.text = "%d:%02d" % [m, s]
	else:
		countdown_label.text = "%d" % int(ceil(seconds))

func _setup_team_icons() -> void:
	# Drop any icons left over from the .tscn or a previous run, then
	# pre-allocate the pool once.
	for child in team_status.get_children():
		child.queue_free()
	_team_icons.clear()
	for i in MAX_TEAM_ICONS:
		var icon := ColorRect.new()
		icon.custom_minimum_size = ICON_SIZE
		icon.visible = false
		team_status.add_child(icon)
		_team_icons.append(icon)

func render_team_status(players: Array) -> void:
	var n: int = mini(players.size(), _team_icons.size())
	for i in n:
		var player: Dictionary = players[i]
		var clown_team: bool = player.get("team") == "clown"
		var frozen: bool = bool(player.get("frozen"))
		var icon: ColorRect = _team_icons[i]
		icon.color = CLOWN_COLOR if clown_team else MIME_COLOR
		icon.modulate.a = ICON_ALPHA_FROZEN if frozen else ICON_ALPHA_ACTIVE
		icon.visible = true
	for i in range(n, _team_icons.size()):
		_team_icons[i].visible = false

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
			line.modulate.a = maxf(LOG_FADE_MIN, pow(LOG_FADE_BASE, age_from_newest))

func flash_frozen(by_team: String, by_name: String) -> void:
	var verb := "mimed" if by_team == "mime" else "clowned"
	frozen_overlay.text = "you've been %s by %s!" % [verb, by_name]
	frozen_overlay.modulate.a = 1.0
	var tw := create_tween()
	tw.tween_property(frozen_overlay, "modulate:a", 0.0, FROZEN_FLASH_FADE_S)

func clear_frozen_overlay() -> void:
	frozen_overlay.text = ""

func flash_battle_cry(text: String, team: String) -> void:
	battle_cry_label.text = text
	battle_cry_label.modulate = Color(MIME_COLOR.r, MIME_COLOR.g, MIME_COLOR.b, 1.0) if team == "mime" else Color(CLOWN_COLOR.r, CLOWN_COLOR.g, CLOWN_COLOR.b, 1.0)
	var tw := create_tween()
	tw.tween_property(battle_cry_label, "modulate:a", 1.0, BATTLE_CRY_FADE_IN_S)
	tw.tween_interval(BATTLE_CRY_HOLD_S)
	tw.tween_property(battle_cry_label, "modulate:a", 0.0, BATTLE_CRY_FADE_OUT_S)

## Reuses the centered BattleCry label to flash "DISPERSE!" in white when the
## free-roam phase begins, so the call to spread out is as visible as a
## turn battle cry. The small left-side event log gets no entry for this
## phase - the centered banner is the entire announcement.
func flash_disperse() -> void:
	battle_cry_label.text = "DISPERSE!"
	battle_cry_label.modulate = Color(1.0, 1.0, 1.0, 1.0)
	var tw := create_tween()
	tw.tween_property(battle_cry_label, "modulate:a", 1.0, BATTLE_CRY_FADE_IN_S)
	tw.tween_interval(DISPERSE_HOLD_S)
	tw.tween_property(battle_cry_label, "modulate:a", 0.0, DISPERSE_FADE_OUT_S)

func show_end(victory: bool) -> void:
	end_label.text = "Victory!" if victory else "Failure."
	end_overlay.visible = true
