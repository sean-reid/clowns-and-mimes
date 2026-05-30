// Freeze-projectile simulation shared between the room Durable Object and
// the Godot client. The room owns the authoritative step; the client
// replays the same math locally for snappy prediction (client PR follows).
//
// Projectiles fly in a straight 3D line (no gravity) from the shooter's
// aim direction. They terminate on: a wall, an enemy hit, or lifetime
// expiry. World bounds need no special handling here — the maze carries
// boundary walls on plane and top/bottom walls on Möbius, so the wall
// check dissipates a projectile that reaches a hard edge; the wrapping
// axes (torus both, Klein both, Möbius x) are handled by the same
// topology wrap the players use.

import type { Projectile, Team, Topology, Vec3 } from './protocol.ts';
import { pathCrossesWall, type WallSegment } from './labyrinth.ts';
import { topologyDistance, wrapPositionFromStep } from './topology.ts';
import { BODY_VERTICAL_EXTENT } from './physics.ts';
import { PLAYER_RADIUS } from './labyrinth.ts';

// Travel speed in world units per second. Fast enough to land at moderate
// range, slow enough to strafe-dodge. Tuned by playtest after the client
// shooting PR lands.
export const PROJECTILE_SPEED = 16;
// Collision half-extent of the projectile itself, added to the player
// radius for the hit test.
export const PROJECTILE_RADIUS = 0.2;
// Center-to-center XZ distance under which a projectile freezes an enemy.
// Sum of the two radii plus a small feel margin.
export const PROJECTILE_HIT_RADIUS = PLAYER_RADIUS + PROJECTILE_RADIUS + 0.2;
// Flight time before a projectile dissipates if it hits nothing. At
// PROJECTILE_SPEED this is ~40 units of travel — roughly the arena's
// half-width — so a clean miss expires rather than orbiting a torus.
export const PROJECTILE_LIFETIME_MS = 2500;
// Minimum gap between shots from one shooter. Per-shooter and persists
// across freeze/save events (tracked by the caller, not reset on those).
export const SHOOT_COOLDOWN_MS = 1500;
// Spawn the projectile just ahead of the shooter so it doesn't
// immediately self-collide with the owner's body.
export const PROJECTILE_SPAWN_OFFSET = PLAYER_RADIUS + PROJECTILE_RADIUS + 0.1;
// Bound on client clock skew when stamping the spawn timestamp, mirroring
// the jump-arc clamp in gameSimulation.ts.
export const PROJECTILE_CLIENT_CLOCK_SKEW_MS = 500;

function vlen(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Build a projectile from a shooter's position and a raw aim direction.
 * Returns null when the direction is degenerate (zero-length) so the
 * caller can reject the shot. `serverNowMs` drives the authoritative
 * lifetime; `spawnNowMs` is the (already clock-skew-clamped) client
 * timestamp stamped onto `spawnedAt` so the client's predicted trail
 * lines up with the server's without a round-trip.
 */
export function spawnProjectile(
  owner: { id: string; team: Team; position: Vec3 },
  dir: Vec3,
  id: string,
  serverNowMs: number,
  spawnNowMs: number,
): Projectile | null {
  const len = vlen(dir.x, dir.y, dir.z);
  if (len < 1e-6) return null;
  const nx = dir.x / len;
  const ny = dir.y / len;
  const nz = dir.z / len;
  return {
    id,
    ownerId: owner.id,
    team: owner.team,
    position: {
      x: owner.position.x + nx * PROJECTILE_SPAWN_OFFSET,
      y: owner.position.y + ny * PROJECTILE_SPAWN_OFFSET,
      z: owner.position.z + nz * PROJECTILE_SPAWN_OFFSET,
    },
    velocity: { x: nx * PROJECTILE_SPEED, y: ny * PROJECTILE_SPEED, z: nz * PROJECTILE_SPEED },
    spawnedAt: spawnNowMs,
    expiresAt: serverNowMs + PROJECTILE_LIFETIME_MS,
  };
}

export interface ProjectileTarget {
  id: string;
  team: Team;
  position: Vec3;
  frozen: boolean;
}

export interface ProjectileStepContext {
  dt: number;
  nowMs: number;
  walls: readonly WallSegment[];
  topology: Topology;
  worldWidth: number;
  hitRadius: number;
  // Wall-clock ms a player was last unfrozen; undefined if never. A target
  // inside its just-saved grace window is immune, matching the touch-tag
  // rule so a projectile can't re-freeze a freshly-rescued ally's opponent.
  savedAt: (id: string) => number | undefined;
  unfreezeGraceMs: number;
}

// One projectile that ended this tick. victimId is set only for enemy
// hits; wall hits and expiries report the projectile id alone so the
// client can stop rendering the trail either way.
export interface ProjectileHit {
  projectileId: string;
  ownerId: string;
  team: Team;
  victimId?: string;
}

export interface ProjectileStepResult {
  survivors: Projectile[];
  hits: ProjectileHit[];
}

/**
 * Advance every projectile one tick. Pure: returns the survivors (with
 * updated positions) and the projectiles that terminated, without
 * mutating inputs or freezing anyone. The caller applies freezes and
 * broadcasts the resulting events.
 *
 * Resolution per projectile, in order: lifetime expiry, wall collision,
 * enemy hit, then topology wrap for survivors. Friendly fire is off, so
 * same-team and already-frozen targets are skipped.
 */
export function stepProjectiles(
  projectiles: readonly Projectile[],
  targets: readonly ProjectileTarget[],
  ctx: ProjectileStepContext,
): ProjectileStepResult {
  const survivors: Projectile[] = [];
  const hits: ProjectileHit[] = [];
  for (const proj of projectiles) {
    if (ctx.nowMs >= proj.expiresAt) {
      hits.push({ projectileId: proj.id, ownerId: proj.ownerId, team: proj.team });
      continue;
    }
    const candidate: Vec3 = {
      x: proj.position.x + proj.velocity.x * ctx.dt,
      y: proj.position.y + proj.velocity.y * ctx.dt,
      z: proj.position.z + proj.velocity.z * ctx.dt,
    };
    if (
      ctx.walls.length > 0 &&
      pathCrossesWall(ctx.walls, proj.position.x, proj.position.z, candidate.x, candidate.z)
    ) {
      hits.push({ projectileId: proj.id, ownerId: proj.ownerId, team: proj.team });
      continue;
    }
    const victim = findVictim(proj, candidate, targets, ctx);
    if (victim !== null) {
      hits.push({
        projectileId: proj.id,
        ownerId: proj.ownerId,
        team: proj.team,
        victimId: victim,
      });
      continue;
    }
    const wrapped = wrapPositionFromStep(
      { x: proj.position.x, z: proj.position.z },
      { x: candidate.x, z: candidate.z },
      ctx.topology,
      ctx.worldWidth,
    );
    survivors.push({
      ...proj,
      position: { x: wrapped.x, y: candidate.y, z: wrapped.z },
    });
  }
  return { survivors, hits };
}

function findVictim(
  proj: Projectile,
  at: Vec3,
  targets: readonly ProjectileTarget[],
  ctx: ProjectileStepContext,
): string | null {
  for (const t of targets) {
    if (t.team === proj.team) continue;
    if (t.frozen) continue;
    const savedAt = ctx.savedAt(t.id);
    if (savedAt !== undefined && ctx.nowMs - savedAt < ctx.unfreezeGraceMs) continue;
    if (Math.abs(at.y - t.position.y) >= BODY_VERTICAL_EXTENT) continue;
    const d = topologyDistance(
      { x: at.x, z: at.z },
      { x: t.position.x, z: t.position.z },
      ctx.topology,
      ctx.worldWidth,
    );
    if (d <= ctx.hitRadius) return t.id;
  }
  return null;
}
