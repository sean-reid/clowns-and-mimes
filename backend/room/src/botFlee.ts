// Smart flee-target selection for the bot AI. The naive flee - project a point
// straight away from the threat - drives a bot into walls, dead-ends, or the
// arms of a second enemy. This scores a fan of candidate escape points against a
// small cost field and picks the best: reward distance from the nearest enemy,
// penalize a dead-end destination (a wall-cornered point) and a direction the
// bot can't even head straight down (a wall in the immediate way).
//
// The fan is anchored on the straight-away direction, so on open ground with a
// single threat the i=0 candidate (directly away, the farthest point from the
// threat, no wall cost) wins and the result matches the old behavior exactly.
// Pure: same inputs -> same point, mirrored by game/scripts/bot_flee.gd and
// locked cross-language by the bot-flee fixture.

import type { Topology, Vec2 } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedDeltaVec } from '@cm/shared/topology';
import { pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';
import { corneredness } from './botPerception.ts';
import {
  BOT_FLEE_BLOCKED_PENALTY,
  BOT_FLEE_CANDIDATES,
  BOT_FLEE_WALL_PENALTY,
  BOT_TARGET_CORNER_SAMPLE_DIST,
} from '@cm/shared/botTuning';

// Quantize a score the way botPathfinder quantizes cost (1e4), so float noise in
// cos/sin/sqrt between V8 and Godot can't flip the argmax on a symmetric tie -
// equal quantized scores keep the lower (earlier-angle) candidate on both sides.
function q(score: number): number {
  return Math.round(score * 1e4) / 1e4;
}

export function bestFleeTarget(
  botPos: Vec2,
  threatPos: Vec2,
  enemies: readonly Vec2[],
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  projection: number,
): Vec2 {
  // Anchor angle = direction from threat to bot (atan2 is scale-invariant, so
  // the raw wrapped delta gives the same angle as the unit vector without a
  // normalization step that could drift from the GDScript port).
  const d = wrappedDeltaVec(threatPos, botPos, topology, worldWidth);
  // Degenerate (bot sitting on the threat): delta collapses; anchor on +x.
  const baseAngle = d.x === 0 && d.z === 0 ? 0 : Math.atan2(d.z, d.x);
  const k = BOT_FLEE_CANDIDATES;

  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < k; i++) {
    const ang = baseAngle + (i * 2 * Math.PI) / k;
    const candidate = wrapPosition(
      { x: botPos.x + Math.cos(ang) * projection, z: botPos.z + Math.sin(ang) * projection },
      topology,
      worldWidth,
    );
    let nearestEnemyDist = Infinity;
    for (const e of enemies) {
      const d = topologyDistance(candidate, e, topology, worldWidth);
      if (d < nearestEnemyDist) nearestEnemyDist = d;
    }
    // No enemies passed (shouldn't happen while fleeing): fall back to the
    // projection so the distance term is neutral across candidates.
    if (!Number.isFinite(nearestEnemyDist)) nearestEnemyDist = projection;
    const deadEnd = corneredness(candidate, walls, BOT_TARGET_CORNER_SAMPLE_DIST);
    const blocked = pathCrossesWall(walls, botPos.x, botPos.z, candidate.x, candidate.z) ? 1 : 0;
    const score = q(
      nearestEnemyDist - BOT_FLEE_WALL_PENALTY * deadEnd - BOT_FLEE_BLOCKED_PENALTY * blocked,
    );
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return (
    best ??
    wrapPosition(
      {
        x: botPos.x + Math.cos(baseAngle) * projection,
        z: botPos.z + Math.sin(baseAngle) * projection,
      },
      topology,
      worldWidth,
    )
  );
}
