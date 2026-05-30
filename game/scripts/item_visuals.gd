extends RefCounted

## Shared power-up presentation: the category each item type belongs to, the
## category color palette (plan §2: movement = teal, combat = red, info =
## yellow, defense = white), and short HUD-slot labels. Both the world icon
## renderer (item_renderer.gd) and the held-item HUD slot (hud.gd) read from
## here so the two never drift.

const COLOR_MOVEMENT := Color(0.2, 0.85, 0.8)
const COLOR_COMBAT := Color(0.95, 0.25, 0.25)
const COLOR_INFO := Color(0.95, 0.85, 0.2)
const COLOR_DEFENSE := Color(0.92, 0.92, 0.92)

const _CATEGORY := {
	"leap": "movement",
	"portal": "movement",
	"surge": "combat",
	"overcharge": "combat",
	"radar": "info",
	"cloak": "defense",
	"clone": "defense",
}

const _COLOR := {
	"movement": COLOR_MOVEMENT,
	"combat": COLOR_COMBAT,
	"info": COLOR_INFO,
	"defense": COLOR_DEFENSE,
}

# Short slot labels - the HUD slot is small, so abbreviate. The full power-up
# name lives in the (later) tutorial / tooltip surface.
const _LABEL := {
	"leap": "LEAP",
	"portal": "PORT",
	"surge": "SURGE",
	"clone": "CLONE",
	"radar": "RADAR",
	"overcharge": "OVER",
	"cloak": "CLOAK",
}

static func category(item_type: String) -> String:
	return _CATEGORY.get(item_type, "movement")

static func color(item_type: String) -> Color:
	return _COLOR.get(category(item_type), COLOR_MOVEMENT)

static func label(item_type: String) -> String:
	return _LABEL.get(item_type, item_type.to_upper())
