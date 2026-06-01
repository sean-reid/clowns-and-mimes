// Team-coordination layer for the bot AI: the shared "blackboard" where bots
// reconcile intentions that would otherwise collide. Pure - it reads a roster
// snapshot and returns assignments the per-bot decision then consults.
//
// First responsibility: rescue claims. Left to themselves every idle bot picks
// its own nearest frozen ally, so a cluster of bots swarms one teammate while
// the others stay frozen. assignRescues matches each frozen teammate to a
// single rescuer (the closest free bot), spreading the bots across distinct
// allies instead.

import type { PlayerState, Topology } from '@cm/shared';
import { topologyDistance } from '@cm/shared/topology';

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
  pairs.sort((a, b) => a.dist - b.dist);

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
