extends Node

## Root scene controller. Hosts the active screen and swaps between flows.

@onready var holder: Node = $Holder

const TITLE := preload("res://scenes/title_screen.tscn")
const MENU := preload("res://scenes/main_menu.tscn")
const MENU_V2 := preload("res://scenes/menu_v2.tscn")
const LOBBY := preload("res://scenes/lobby.tscn")
const PARTY := preload("res://scenes/party.tscn")
const ARENA := preload("res://scenes/arena.tscn")

func _ready() -> void:
	_swap(TITLE.instantiate())

func _swap(node: Node) -> void:
	for child in holder.get_children():
		child.queue_free()
	holder.add_child(node)
	if node.has_signal("requested_screen"):
		node.requested_screen.connect(_on_request)

func _on_request(screen: String) -> void:
	match screen:
		"menu":
			_swap(_menu_scene().instantiate())
		"lobby":
			_swap(LOBBY.instantiate())
		"party":
			_swap(PARTY.instantiate())
		"arena":
			_swap(ARENA.instantiate())
		"title":
			_swap(TITLE.instantiate())

func _menu_scene() -> PackedScene:
	return MENU if Settings.use_v1_menu else MENU_V2
