extends Node

## Procedural username generator. Pairs a silly adjective with a clown/mime
## themed noun and a three-digit suffix. The word lists are the TS-side
## canonical lists in backend/shared/src/names.ts, mirrored here via
## scripts/gen-shared-constants.mjs so the client and the server bot-name
## generator stay in sync. Domain size: ADJECTIVES x NOUNS x 1000.

const SharedConstants := preload("res://scripts/shared_constants.gd")

func generate() -> String:
	var adjectives: Array = SharedConstants.NAME_ADJECTIVES
	var nouns: Array = SharedConstants.NAME_NOUNS
	var adj: String = adjectives[randi() % adjectives.size()]
	var noun: String = nouns[randi() % nouns.size()]
	var num := randi() % 1000
	return "%s%s%03d" % [adj, noun, num]

func combinations() -> int:
	return SharedConstants.NAME_ADJECTIVES.size() * SharedConstants.NAME_NOUNS.size() * 1000
