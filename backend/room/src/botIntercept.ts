// Predictive interception for the bot AI. A bot that aims (or drives) at where
// a target *is* always trails a moving target: by the time the projectile - or
// the bot itself - arrives, the target has moved on. interceptPoint estimates
// where the target will be after the flight/travel time and returns that point,
// so the caller can aim/steer at the lead instead.
//
// Two fixed point-iterations: estimate travel time to the current prediction,
// advance the target along its velocity by that time, refine once. With a zero
// velocity (target standing still, or no velocity known yet) the prediction is
// just the target's current position, so aim/chase are unchanged - the lead only
// kicks in for a target that's actually moving. Pure: mirrored by
// game/scripts/bot_intercept.gd and locked cross-language by the fixture.

import type { Topology, Vec2 } from '@cm/shared';
import { topologyDistance, wrapPosition } from '@cm/shared/topology';

// Refinement passes. Two is plenty for the closing speeds here and matches the
// GDScript port; it is an algorithm constant, not a tuning knob.
const INTERCEPT_ITERATIONS = 2;

export function interceptPoint(
  shooterPos: Vec2,
  targetPos: Vec2,
  targetVel: Vec2,
  speed: number,
  topology: Topology,
  worldWidth: number,
): Vec2 {
  if (speed <= 0) return { x: targetPos.x, z: targetPos.z };
  let predicted: Vec2 = { x: targetPos.x, z: targetPos.z };
  for (let i = 0; i < INTERCEPT_ITERATIONS; i++) {
    const t = topologyDistance(shooterPos, predicted, topology, worldWidth) / speed;
    predicted = wrapPosition(
      { x: targetPos.x + targetVel.x * t, z: targetPos.z + targetVel.z * t },
      topology,
      worldWidth,
    );
  }
  return predicted;
}
