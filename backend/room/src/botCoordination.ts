// Team-coordination layer for the bot AI: the shared "blackboard" where bots
// reconcile intentions that would otherwise collide. Pure - it reads a roster
// snapshot and returns assignments the per-bot decision then consults.
//
// First responsibility: rescue claims. Left to themselves every idle bot picks
// its own nearest frozen ally, so a cluster of bots swarms one teammate while
// the others stay frozen. assignRescues matches each frozen teammate to a
// single rescuer (the closest free bot), spreading the bots across distinct
// allies instead.

import type { PlayerState, Topology, Vec2 } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedDeltaVec } from '@cm/shared/topology';
import { bestVisibleEnemy } from './botPerception.ts';
import type { WallSegment } from '@cm/shared/labyrinth';
import { BOT_CHASE_FLANK_RADIUS, BOT_VISION_RADIUS } from '@cm/shared/botTuning';

export interface RescueClaim {
  target: PlayerState;
  dist: number;
}

/**
 * Assign each frozen teammate to at most one bot rescuer and vice versa, so two
 * bots never converge on the same ally. Greedy over all (bot, frozen-ally)
 * pairs sorted by distance: the globally closest pair is matched first, then
 * the next closest pair whose bot and ally are both still free, and so on.
 * Sorting makes the result independent of roster iteration order.
 *
 * Returns a map from bot id to its claimed ally. Bots with no entry have no
 * rescue this tick (a closer teammate took every reachable ally), so they fall
 * through to their other goals. Only frozen teammates within `visionRadius`
 * are considered, matching the original solo rescue scan.
 */
export function assignRescues(
  players: Iterable<PlayerState>,
  topology: Topology,
  worldWidth: number,
  visionRadius: number,
): Map<string, RescueClaim> {
  const roster = [...players];
  const rescuers = roster.filter((p) => p.bot && !p.frozen);
  const frozen = roster.filter((p) => p.frozen);

  const pairs: Array<{ botId: string; ally: PlayerState; dist: number }> = [];
  for (const bot of rescuers) {
    for (const ally of frozen) {
      if (ally.team !== bot.team) continue;
      const dist = topologyDistance(bot.position, ally.position, topology, worldWidth);
      if (dist < visionRadius) pairs.push({ botId: bot.id, ally, dist });
    }
  }
  // Total order: distance, then bot id, then ally id. The id tiebreaks make the
  // result independent of sort stability, so the offline GDScript port (whose
  // sort_custom is not stable) resolves exact-distance ties identically.
  pairs.sort(
    (a, b) =>
      a.dist - b.dist ||
      (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0) ||
      (a.ally.id < b.ally.id ? -1 : a.ally.id > b.ally.id ? 1 : 0),
  );

  const claimedBots = new Set<string>();
  const claimedAllies = new Set<string>();
  const out = new Map<string, RescueClaim>();
  for (const p of pairs) {
    if (claimedBots.has(p.botId) || claimedAllies.has(p.ally.id)) continue;
    out.set(p.botId, { target: p.ally, dist: p.dist });
    claimedBots.add(p.botId);
    claimedAllies.add(p.ally.id);
  }
  return out;
}

// A flank slot for a bot chasing a target also being chased by a teammate: the
// bot should approach `goal` (a point on a ring around the target) rather than
// the target's exact position, so co-chasers converge from spread angles.
export interface ChaseClaim {
  targetId: string;
  goal: Vec2;
}

/**
 * Second responsibility: chase coordination. Left alone every bot drives at the
 * exact position of the enemy it's chasing, so a pack hunting one target
 * conga-lines in behind it from a single direction and the target just runs.
 * assignChases finds each target chased by two or more bots and fans those bots
 * out around it: each is given a `goal` on a ring of radius `flankRadius` at a
 * distinct angular slot, turning the pack into a pincer that cuts off escape.
 *
 * Each bot's chased target is recomputed here with bestVisibleEnemy (the same
 * pick the decision layer makes), so this stays a pure function of the roster +
 * walls - no per-bot engagement state is threaded in. A bot whose decision
 * later locks a different target (hysteresis) simply won't match its claim's
 * targetId and falls back to a direct chase. Solo chasers get no claim, so their
 * behavior is unchanged. The slots are anchored at the first bot's bearing and
 * spaced evenly; bots are ranked by bearing (then id) so the assignment is
 * stable, order-independent, and matches the offline GDScript port.
 */
export function assignChases(
  players: Iterable<PlayerState>,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  now: number,
  visionRadius: number = BOT_VISION_RADIUS,
  flankRadius: number = BOT_CHASE_FLANK_RADIUS,
): Map<string, ChaseClaim> {
  const roster = [...players];
  // Group bot chasers by the enemy each would engage.
  const groups = new Map<string, { target: PlayerState; bots: PlayerState[] }>();
  for (const bot of roster) {
    if (!bot.bot || bot.frozen) continue;
    const target = bestVisibleEnemy(bot, roster, walls, topology, worldWidth, now);
    if (!target) continue;
    if (topologyDistance(bot.position, target.position, topology, worldWidth) >= visionRadius) {
      continue;
    }
    const group = groups.get(target.id) ?? { target, bots: [] };
    group.bots.push(bot);
    groups.set(target.id, group);
  }

  const out = new Map<string, ChaseClaim>();
  for (const { target, bots } of groups.values()) {
    if (bots.length < 2) continue; // a lone chaser drives straight at the target
    const ranked = bots
      .map((b) => {
        const d = wrappedDeltaVec(target.position, b.position, topology, worldWidth);
        return { bot: b, bearing: Math.atan2(d.z, d.x) };
      })
      .sort((a, b) => a.bearing - b.bearing || (a.bot.id < b.bot.id ? -1 : 1));
    const base = ranked[0].bearing;
    const k = ranked.length;
    for (let r = 0; r < k; r++) {
      const slot = base + (r * 2 * Math.PI) / k;
      const goal = wrapPosition(
        {
          x: target.position.x + Math.cos(slot) * flankRadius,
          z: target.position.z + Math.sin(slot) * flankRadius,
        },
        topology,
        worldWidth,
      );
      out.set(ranked[r].bot.id, { targetId: target.id, goal });
    }
  }
  return out;
}
