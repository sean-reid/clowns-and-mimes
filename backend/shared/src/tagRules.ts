// Pure tag/unfreeze validation. Lifted out of room.ts so the same rules
// can be exercised in unit tests without spinning up a Durable Object.
// The shape of the inputs intentionally avoids importing PlayerState
// directly: callers thread the minimal fields they need.

import type { Team, Topology, Vec3 } from './protocol.ts';
import { topologyDistance } from './topology.ts';
import { pathCrossesWall, type WallSegment } from './labyrinth.ts';
import { verticallyOverlapping } from './physics.ts';

export interface TagCandidate {
  team: Team;
  position: Vec3;
  frozen: boolean;
}

export interface TagContext {
  // Resolved victim position. For lag-compensated checks the caller passes
  // the rewound position; for strict-radius bot checks it passes the
  // current position. Keeping this out of the inputs means tagRules.ts
  // has no opinion on history.
  victimResolvedPos: Vec3;
  phase: string;
  // Wall-clock ms when the victim was last unfrozen (= when the
  // "just saved" grace window started). undefined if never saved.
  victimSavedAtMs: number | undefined;
  unfreezeGraceMs: number;
  nowMs: number;
  walls: readonly WallSegment[];
  topology: Topology;
  worldWidth: number;
}

/**
 * Returns null if the tag should fire, or a string reason code matching
 * what room.ts has historically broadcast. Reason codes are stable wire
 * values - clients render their own copy keyed off the string.
 */
export function tagRejectionReason(
  attacker: TagCandidate,
  victim: TagCandidate,
  radius: number,
  ctx: TagContext,
): string | null {
  if (attacker.team === victim.team) return 'same_team';
  if (attacker.frozen) return 'you_are_frozen';
  if (victim.frozen) return 'already_frozen';
  if (ctx.phase !== `turn_${attacker.team}`) return 'not_your_turn';
  if (ctx.victimSavedAtMs !== undefined && ctx.nowMs - ctx.victimSavedAtMs < ctx.unfreezeGraceMs)
    return 'just_saved';
  const d = topologyDistance(
    attacker.position,
    ctx.victimResolvedPos,
    ctx.topology,
    ctx.worldWidth,
  );
  if (d > radius) return `out_of_range:${d.toFixed(2)}`;
  if (
    ctx.walls.length > 0 &&
    pathCrossesWall(
      ctx.walls,
      attacker.position.x,
      attacker.position.z,
      ctx.victimResolvedPos.x,
      ctx.victimResolvedPos.z,
    )
  )
    return 'wall_in_way';
  if (!verticallyOverlapping({ position: attacker.position }, { position: victim.position }))
    return 'vertical_separation';
  return null;
}

export function canTag(
  attacker: TagCandidate,
  victim: TagCandidate,
  radius: number,
  ctx: TagContext,
): boolean {
  return tagRejectionReason(attacker, victim, radius, ctx) === null;
}
