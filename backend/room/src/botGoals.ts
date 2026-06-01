// Go-to-point goal selection for the bot AI. Pure helpers that turn world
// state into a single destination the steering layer then paths toward; they
// own no state and read only a snapshot. Two opportunistic goals live here:
//
//  - collecting a floor item the bot can reach (it walks over items to pick
//    them up, so "go stand on it" is the whole behavior), and
//  - following through on a portal the bot just opened by walking into its own
//    entry mouth, since the generic flee vector would never aim there.
//
// Both feed the same pathfind-to-a-Vec2 machinery the other movement modes
// use; only the destination differs.

import type { Topology, Vec2, Vec3 } from '@cm/shared';
import { topologyDistance, wrappedUnitDelta } from '@cm/shared/topology';

// Nearest floor item within `seekRadius`, or null when none is close enough.
// The caller only seeks while holding no item (no stacking on pickup).
export function nearestItemTarget(
  botPos: Vec2,
  items: ReadonlyArray<{ position: Vec3 }>,
  topology: Topology,
  worldWidth: number,
  seekRadius: number,
): Vec2 | null {
  let best: Vec2 | null = null;
  let bestDist = Infinity;
  for (const item of items) {
    const d = topologyDistance(botPos, item.position, topology, worldWidth);
    if (d <= seekRadius && d < bestDist) {
      bestDist = d;
      best = { x: item.position.x, z: item.position.z };
    }
  }
  return best;
}

/**
 * Where a fleeing bot should walk to take the portal it opened, or null to
 * ignore the portal this tick. `away` is the bot's flee direction (unit vector
 * pointing away from the pursuer). Returns the entry mouth only when:
 *
 *  - the bot is on the entry side (closer to `entry` than `exit`), so once it
 *    teleports out by the exit it won't immediately path back and bounce, and
 *  - the mouth lies in the flee hemisphere, so the bot never doubles back
 *    toward its pursuer just to reach it.
 */
export function portalEscapeTarget(
  botPos: Vec2,
  away: Vec2,
  entry: Vec2,
  exit: Vec2,
  topology: Topology,
  worldWidth: number,
): Vec2 | null {
  const dEntry = topologyDistance(botPos, entry, topology, worldWidth);
  const dExit = topologyDistance(botPos, exit, topology, worldWidth);
  if (dEntry > dExit) return null;
  const toMouth = wrappedUnitDelta(botPos, entry, topology, worldWidth);
  if (toMouth.x * away.x + toMouth.z * away.z <= 0) return null;
  return { x: entry.x, z: entry.z };
}
