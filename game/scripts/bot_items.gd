extends RefCounted

## Item-value layer for the offline bot brain. Mirrors backend/room/src/botItems.ts:
## decides whether the bot fires its single held power-up this tick. Each type is
## only worth spending when its effect serves the bot's current intent, so this is
## a per-item policy, not a "use it the moment you have one" reflex - holding a
## power-up in reserve is a valid (often better) choice.
##
## Radar is the one type whose value isn't a body effect: for an AI that already
## perceives nearby players, the reveal is dead weight, so the bot holds it until
## blind to every actionable enemy, then spends it to relocate the nearest one -
## the decision returns a `memory_seed` the caller writes into investigate memory.
##
## ctx: {chasing, fleeing, want_jump, can_shoot, enemy_dist, sprint_energy,
##       has_actionable_enemy, nearest_enemy_pos: Vector3|null}
## params: {sprint_trigger_radius, max_sprint, tag_radius, jump_evade_buffer}
## Returns: {use: bool, memory_seed: Vector3|null}.

static func decide_item_use(item: String, ctx: Dictionary, params: Dictionary) -> Dictionary:
	match item:
		"radar":
			# Spend only when blind to every actionable enemy but one exists to
			# relocate; otherwise hold rather than waste the reveal.
			if not ctx.has_actionable_enemy and ctx.nearest_enemy_pos != null:
				return {"use": true, "memory_seed": ctx.nearest_enemy_pos}
			return _hold()
		"leap":
			# Boost the jump the bot is already taking this tick.
			return _spend() if ctx.want_jump else _hold()
		"surge":
			# Sprint boost when engaged at close range and low on energy.
			var engaged: bool = ctx.chasing or ctx.fleeing
			var close: bool = ctx.enemy_dist < float(params.sprint_trigger_radius)
			var tired: bool = ctx.sprint_energy < float(params.max_sprint) * 0.5
			return _spend() if (engaged and close and tired) else _hold()
		"overcharge":
			# Arm the shot the bot is about to fire.
			return _spend() if ctx.can_shoot else _hold()
		"cloak":
			# Break contact while fleeing a close pursuer.
			var fleeing_close: bool = ctx.fleeing and ctx.enemy_dist <= float(params.sprint_trigger_radius)
			return _spend() if fleeing_close else _hold()
		"clone":
			# A decoy is useful whenever the bot is actively engaged either way.
			return _spend() if (ctx.chasing or ctx.fleeing) else _hold()
		"portal":
			# Last-ditch escape when a tagger is right on top of the bot.
			var threshold: float = float(params.tag_radius) + float(params.jump_evade_buffer) * 2.0
			return _spend() if (ctx.fleeing and ctx.enemy_dist <= threshold) else _hold()
		_:
			return _hold()

static func _hold() -> Dictionary:
	return {"use": false, "memory_seed": null}

static func _spend() -> Dictionary:
	return {"use": true, "memory_seed": null}
