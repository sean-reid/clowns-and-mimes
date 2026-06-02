extends RefCounted

## Team-coordination layer for the offline bot brain. Mirrors
## backend/room/src/botCoordination.ts: a pure pass over the roster that returns
## rescue claims the per-bot decision then consults.
##
## Left alone, every idle bot picks its own nearest frozen ally, so a cluster
## swarms one teammate while the rest stay frozen. assign_rescues matches each
## frozen teammate to a single rescuer (the closest free bot), spreading bots
## across distinct allies.

const TopologyScript := preload("res://scripts/topology/topology.gd")

## Assign each frozen teammate to at most one bot rescuer and vice versa. Greedy
## over all (bot, frozen-ally) pairs in a total order - distance, then bot id,
## then ally id - so two bots never converge on the same ally and the result is
## independent of roster order (and of sort stability, matching the TS side).
## Returns a Dictionary bot_id -> {target: ally dict, dist: float}. Bots with no
## entry have no rescue this tick. Only frozen teammates within vision_radius
## count, matching the solo rescue scan.
static func assign_rescues(players: Array, topology: TopologyScript, vision_radius: float) -> Dictionary:
	var rescuers: Array = []
	var frozen: Array = []
	for p in players:
		if p.get("bot", false) and not p.get("frozen", false):
			rescuers.append(p)
		if p.get("frozen", false):
			frozen.append(p)

	var pairs: Array = []
	for bot in rescuers:
		for ally in frozen:
			if ally.team != bot.team:
				continue
			var d: float = topology.distance(bot.position, ally.position)
			if d < vision_radius:
				pairs.append({"bot_id": bot.id, "ally": ally, "dist": d})
	pairs.sort_custom(_pair_less)

	var claimed_bots: Dictionary = {}
	var claimed_allies: Dictionary = {}
	var out: Dictionary = {}
	for pr in pairs:
		if claimed_bots.has(pr.bot_id) or claimed_allies.has(pr.ally.id):
			continue
		out[pr.bot_id] = {"target": pr.ally, "dist": pr.dist}
		claimed_bots[pr.bot_id] = true
		claimed_allies[pr.ally.id] = true
	return out

# Total order matching botCoordination.ts: distance, then bot id, then ally id.
static func _pair_less(a: Dictionary, b: Dictionary) -> bool:
	if a.dist != b.dist:
		return a.dist < b.dist
	if a.bot_id != b.bot_id:
		return a.bot_id < b.bot_id
	return a.ally.id < b.ally.id
