// Pure perception helpers for the bot AI, extracted from
// botManager.simulate so the "what can this bot sense right now" layer is
// testable in isolation and can be reused by the offline brain. No state is
// mutated here: each function reads the roster + world and returns a fact.
//
// Behavior is preserved verbatim from the original inline simulate logic;
// botSteering.test.ts / simulate.test.ts are the regression net.

import type { PlayerState, Topology, Vec2 } from '@cm/shared';
import { topologyDistance } from '@cm/shared/topology';
import { pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';

// A player is hidden from bot perception while a Cloak power-up is active.
// Mirrors the client's visual hide so bots can't see or react to a cloaked
// enemy, matching what the cloaked player's opponents observe on screen.
export function isCloaked(p: PlayerState, now: number): boolean {
  return p.cloakUntil !== undefined && p.cloakUntil > now;
}

// Line of sight: a bot can see a point when no wall segment lies between
// them. With no walls (open topologies) everything is visible.
export function botCanSee(walls: readonly WallSegment[], from: Vec2, to: Vec2): boolean {
  if (walls.length === 0) return true;
  return !pathCrossesWall(walls, from.x, from.z, to.x, to.z);
}

// Nearest enemy the bot currently has line of sight to. Not range-limited:
// the caller gates engagement on BOT_VISION_RADIUS. Skips same-team, frozen,
// and cloaked players.
export function nearestVisibleEnemy(
  bot: PlayerState,
  players: Iterable<PlayerState>,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  now: number,
): PlayerState | null {
  let best: PlayerState | null = null;
  let bestDist = Infinity;
  for (const other of players) {
    if (other.id === bot.id) continue;
    if (other.team === bot.team) continue;
    if (other.frozen) continue;
    if (isCloaked(other, now)) continue;
    if (!botCanSee(walls, bot.position, other.position)) continue;
    const d = topologyDistance(bot.position, other.position, topology, worldWidth);
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}

// Nearest enemy anywhere on the field: no line-of-sight, range, or cloak
// filter. This is the radar power-up's view of the world (it reveals the whole
// enemy team on the minimap, seeing through walls and cloak), as opposed to
// nearestVisibleEnemy which is what the bot can act on directly. Skips
// same-team and frozen players. Returns the target and its distance, or
// null/Infinity when none qualifies.
export function nearestEnemy(
  bot: PlayerState,
  players: Iterable<PlayerState>,
  topology: Topology,
  worldWidth: number,
): { target: PlayerState | null; dist: number } {
  let target: PlayerState | null = null;
  let dist = Infinity;
  for (const other of players) {
    if (other.id === bot.id) continue;
    if (other.team === bot.team) continue;
    if (other.frozen) continue;
    const d = topologyDistance(bot.position, other.position, topology, worldWidth);
    if (d < dist) {
      dist = d;
      target = other;
    }
  }
  return { target, dist };
}

// Nearest frozen ally within visionRadius (no line-of-sight requirement,
// matching the original rescue scan). Returns the target and its distance,
// or null/Infinity when none qualifies.
export function nearestFrozenAlly(
  bot: PlayerState,
  players: Iterable<PlayerState>,
  topology: Topology,
  worldWidth: number,
  visionRadius: number,
): { target: PlayerState | null; dist: number } {
  let target: PlayerState | null = null;
  let dist = Infinity;
  for (const other of players) {
    if (other.id === bot.id) continue;
    if (other.team !== bot.team) continue;
    if (!other.frozen) continue;
    const d = topologyDistance(bot.position, other.position, topology, worldWidth);
    if (d < visionRadius && d < dist) {
      dist = d;
      target = other;
    }
  }
  return { target, dist };
}
