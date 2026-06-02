extends RefCounted

## Freeze-projectile simulation for offline play. Pure port of
## backend/shared/src/projectiles.ts: straight-line flight (no gravity),
## terminating on wall / enemy head-sphere hit / lifetime expiry, with topology
## wrap for survivors. The offline manager owns the live state + cooldown/turn
## gating (mirrors projectileManager.ts); this is just the per-tick math.
##
## Projectile dict: {id, owner_id, team, position:Vector3, velocity:Vector3,
##   spawned_at:int, expires_at:int, piercing:bool}.
## Target dict: {id, team, position:Vector3, frozen:bool}.

const SharedConstants := preload("res://scripts/shared_constants.gd")
const WallGeometry := preload("res://scripts/wall_geometry.gd")
const TopologyScript := preload("res://scripts/topology/topology.gd")

const PROJECTILE_SPEED := SharedConstants.PROJECTILE_SPEED
const PROJECTILE_RADIUS := SharedConstants.PROJECTILE_RADIUS
const PROJECTILE_LIFETIME_MS := int(SharedConstants.PROJECTILE_LIFETIME_MS)
const SHOOT_COOLDOWN_MS := int(SharedConstants.SHOOT_COOLDOWN_MS)
const EYE_HEIGHT := SharedConstants.EYE_HEIGHT
const HEAD_CENTER_HEIGHT := SharedConstants.HEAD_CENTER_HEIGHT
# Derived (computed, not literals): head sphere + projectile radius for the hit
# test; spawn just ahead of the body so it doesn't self-collide.
const PROJECTILE_HIT_RADIUS := SharedConstants.HEAD_RADIUS + SharedConstants.PROJECTILE_RADIUS
const PROJECTILE_SPAWN_OFFSET := SharedConstants.PLAYER_RADIUS + SharedConstants.PROJECTILE_RADIUS + 0.1

## Build a projectile from a shooter and a raw aim direction, or {} when the
## direction is degenerate. Launches from the shooter's eye along the aim ray.
static func spawn_projectile(
	owner: Dictionary, dir: Vector3, id: String, server_now_ms: int, spawn_now_ms: int
) -> Dictionary:
	var length := dir.length()
	if length < 1e-6:
		return {}
	var n := dir / length
	var pos: Vector3 = owner.position
	return {
		"id": id,
		"owner_id": owner.id,
		"team": owner.team,
		"position": Vector3(
			pos.x + n.x * PROJECTILE_SPAWN_OFFSET,
			pos.y + EYE_HEIGHT + n.y * PROJECTILE_SPAWN_OFFSET,
			pos.z + n.z * PROJECTILE_SPAWN_OFFSET
		),
		"velocity": n * PROJECTILE_SPEED,
		"spawned_at": spawn_now_ms,
		"expires_at": server_now_ms + PROJECTILE_LIFETIME_MS,
		"piercing": false,
	}

## Advance every projectile one tick. Pure: returns {survivors, hits} without
## mutating inputs or freezing anyone (the caller applies freezes). Resolution
## order per projectile: expiry, wall, enemy hit, then wrap for survivors.
## ctx: {dt, now_ms, walls, topology, hit_radius, saved_at:Dictionary(id->ms),
##   unfreeze_grace_ms}.
static func step_projectiles(projectiles: Array, targets: Array, ctx: Dictionary) -> Dictionary:
	var survivors: Array = []
	var hits: Array = []
	for proj in projectiles:
		if int(ctx.now_ms) >= int(proj.expires_at):
			hits.append({"projectile_id": proj.id, "owner_id": proj.owner_id, "team": proj.team})
			continue
		var p: Vector3 = proj.position
		var v: Vector3 = proj.velocity
		var candidate := p + v * float(ctx.dt)
		var walls: Array = ctx.walls
		if (
			not proj.get("piercing", false)
			and not walls.is_empty()
			and WallGeometry.path_crosses_wall(walls, p.x, p.z, candidate.x, candidate.z)
		):
			hits.append({"projectile_id": proj.id, "owner_id": proj.owner_id, "team": proj.team})
			continue
		var victim := _find_victim(proj, candidate, targets, ctx)
		if victim != "":
			hits.append(
				{
					"projectile_id": proj.id,
					"owner_id": proj.owner_id,
					"team": proj.team,
					"victim_id": victim,
				}
			)
			continue
		var topo: TopologyScript = ctx.topology
		var wrapped := topo.wrap_step(Vector3(p.x, 0.0, p.z), Vector3(candidate.x, 0.0, candidate.z))
		var s: Dictionary = proj.duplicate()
		s.position = Vector3(wrapped.x, candidate.y, wrapped.z)
		survivors.append(s)
	return {"survivors": survivors, "hits": hits}

static func _find_victim(proj: Dictionary, at: Vector3, targets: Array, ctx: Dictionary) -> String:
	var topo: TopologyScript = ctx.topology
	var hit_radius: float = ctx.hit_radius
	var saved_at: Dictionary = ctx.get("saved_at", {})
	var grace: float = ctx.get("unfreeze_grace_ms", 0)
	for t in targets:
		if t.team == proj.team or t.get("frozen", false):
			continue
		if saved_at.has(t.id) and int(ctx.now_ms) - int(saved_at[t.id]) < grace:
			continue
		var tp: Vector3 = t.position
		var dxz := topo.distance(Vector3(at.x, 0.0, at.z), Vector3(tp.x, 0.0, tp.z))
		var dy := at.y - (tp.y + HEAD_CENTER_HEIGHT)
		if dxz * dxz + dy * dy <= hit_radius * hit_radius:
			return t.id
	return ""
