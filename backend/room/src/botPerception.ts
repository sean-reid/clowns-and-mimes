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
import {
  BOT_TARGET_CORNER_SAMPLE_DIST,
  BOT_TARGET_CORNER_WEIGHT,
  BOT_TARGET_ISOLATION_WEIGHT,
  BOT_VISION_RADIUS,
} from '@cm/shared/botTuning';

// Compass directions sampled around a point to gauge how cornered it is. Eight
// is enough resolution to tell open ground from a wall-backed corner; it is not
// a tuning knob (the offline port hardcodes the same 8), so it lives here.
const CORNER_SAMPLES = 8;

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

// Fraction (0..1) of sampled compass directions around a point blocked by a
// wall within sampleDist - a cheap "how boxed in is this spot" proxy. 0 in the
// open; ramps toward 1 in a corner where several directions hit a wall. Used by
// target scoring (a cornered enemy is more catchable) and by flee scoring (a
// cornered flee point is a dead-end to avoid).
export function corneredness(pos: Vec2, walls: readonly WallSegment[], sampleDist: number): number {
  if (walls.length === 0) return 0;
  let blocked = 0;
  for (let k = 0; k < CORNER_SAMPLES; k++) {
    const a = (k / CORNER_SAMPLES) * Math.PI * 2;
    const ex = pos.x + Math.cos(a) * sampleDist;
    const ez = pos.z + Math.sin(a) * sampleDist;
    if (pathCrossesWall(walls, pos.x, pos.z, ex, ez)) blocked++;
  }
  return blocked / CORNER_SAMPLES;
}

// How cut off an enemy is from its own team (0 = an active teammate is right
// beside it, 1 = nearest active teammate is a vision-radius away or there is
// none). Frozen allies don't count - they can't defend or retaliate. An
// isolated enemy is the safer commitment.
function teamIsolation(
  enemy: PlayerState,
  players: readonly PlayerState[],
  topology: Topology,
  worldWidth: number,
  visionRadius: number,
): number {
  let nearest = Infinity;
  for (const other of players) {
    if (other.id === enemy.id) continue;
    if (other.team !== enemy.team) continue;
    if (other.frozen) continue;
    const d = topologyDistance(enemy.position, other.position, topology, worldWidth);
    if (d < nearest) nearest = d;
  }
  if (!Number.isFinite(nearest)) return 1;
  return Math.min(nearest / visionRadius, 1);
}

// Among the enemies the bot can see, the most *catchable* one - not merely the
// nearest. value = -distance + cornered*CORNER_WEIGHT + isolated*ISOLATION_WEIGHT.
// With no walls and symmetric team spacing this reduces to nearestVisibleEnemy
// (cornered = 0, isolation cancels), so it only diverges where there's a real
// tactical edge: an enemy backed against a wall, or cut off from its team. Same
// visibility filters as nearestVisibleEnemy (skip same-team / frozen / cloaked /
// occluded). The caller still gates engagement on BOT_VISION_RADIUS.
export function bestVisibleEnemy(
  bot: PlayerState,
  players: Iterable<PlayerState>,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  now: number,
): PlayerState | null {
  const roster = [...players];
  let best: PlayerState | null = null;
  let bestValue = -Infinity;
  for (const other of roster) {
    if (other.id === bot.id) continue;
    if (other.team === bot.team) continue;
    if (other.frozen) continue;
    if (isCloaked(other, now)) continue;
    if (!botCanSee(walls, bot.position, other.position)) continue;
    const dist = topologyDistance(bot.position, other.position, topology, worldWidth);
    const value =
      -dist +
      corneredness(other.position, walls, BOT_TARGET_CORNER_SAMPLE_DIST) *
        BOT_TARGET_CORNER_WEIGHT +
      teamIsolation(other, roster, topology, worldWidth, BOT_VISION_RADIUS) *
        BOT_TARGET_ISOLATION_WEIGHT;
    if (value > bestValue) {
      bestValue = value;
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
