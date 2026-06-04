// Incoming-fire awareness for the bot AI - by sight, not hearing. A projectile
// is a visible object in flight, so a bot reacts only to one it can actually see
// (within vision range, line of sight). Crucially it never saw the muzzle flash,
// so it can't know the exact source: all it can infer from a projectile in
// flight is the line it's travelling - the *direction* the shot came from.
//
// nearestProjectileThreat returns a threat point a short way back along the
// nearest visible, approaching enemy projectile's reverse trajectory: a bearing
// to flee away from, not a claimed origin. The caller (a prey bot with nothing
// visible to flee from directly) steers away from it. Pure: mirrored by
// game/scripts/bot_projectile_threat.gd and locked cross-language by the fixture.

import type { PlayerState, Team, Topology, Vec2 } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedDeltaVec } from '@cm/shared/topology';
import { botCanSee } from './botPerception.ts';
import type { WallSegment } from '@cm/shared/labyrinth';

// Structurally a Projectile (its position/velocity Vec3s are read as XZ here).
export interface SightedProjectile {
  ownerId: string;
  team: Team;
  position: Vec2;
  velocity: Vec2;
}

export function nearestProjectileThreat(
  bot: PlayerState,
  projectiles: Iterable<SightedProjectile>,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  sightRadius: number,
  lookback: number,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDist = Infinity;
  for (const p of projectiles) {
    if (p.ownerId === bot.id) continue;
    if (p.team === bot.team) continue; // only enemy fire is a threat
    const dist = topologyDistance(bot.position, p.position, topology, worldWidth);
    if (dist > sightRadius) continue;
    if (!botCanSee(walls, bot.position, p.position)) continue; // must actually see it
    const vlen = Math.hypot(p.velocity.x, p.velocity.z);
    if (vlen < 1e-6) continue;
    // Only fire that's heading toward this bot is a threat to dodge away from
    // (a shot flying off elsewhere isn't incoming).
    const toBotX = bot.position.x - p.position.x;
    const toBotZ = bot.position.z - p.position.z;
    if (p.velocity.x * toBotX + p.velocity.z * toBotZ <= 0) continue;
    if (dist < bestDist) {
      bestDist = dist;
      // A point back along the reverse trajectory encodes the bearing the shot
      // came from. Short lookback keeps it local (no wrap ambiguity), so this is
      // a direction to flee from - never the unseen muzzle's true position.
      const vx = p.velocity.x / vlen;
      const vz = p.velocity.z / vlen;
      best = wrapPosition(
        { x: p.position.x - vx * lookback, z: p.position.z - vz * lookback },
        topology,
        worldWidth,
      );
    }
  }
  return best;
}

// True when a visible enemy shot is about to pass close enough to the bot to hit
// it - the cue to jump and let it go under. Projects each projectile's straight
// line to its closest approach to the bot: if that miss distance is within
// dodgeRadius and the approach is less than leadTimeS away, dodge. (Lateral
// relocation away from the line is nearestProjectileThreat's job; this is the
// last-instant hop.)
export function shouldDodgeProjectile(
  bot: PlayerState,
  projectiles: Iterable<SightedProjectile>,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  dodgeRadius: number,
  leadTimeS: number,
): boolean {
  for (const p of projectiles) {
    if (p.ownerId === bot.id) continue;
    if (p.team === bot.team) continue;
    if (!botCanSee(walls, bot.position, p.position)) continue;
    // Projectile position relative to the bot, and its closest-approach time.
    const rel = wrappedDeltaVec(bot.position, p.position, topology, worldWidth);
    const vv = p.velocity.x * p.velocity.x + p.velocity.z * p.velocity.z;
    if (vv < 1e-9) continue;
    const tStar = -(rel.x * p.velocity.x + rel.z * p.velocity.z) / vv;
    if (tStar <= 0 || tStar > leadTimeS) continue; // moving away, or not imminent
    const cx = rel.x + p.velocity.x * tStar;
    const cz = rel.z + p.velocity.z * tStar;
    if (Math.hypot(cx, cz) <= dodgeRadius) return true;
  }
  return false;
}
