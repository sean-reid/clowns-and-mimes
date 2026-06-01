// Pure steering helpers for the bot AI, extracted from botManager.simulate.
// "Given a desired direction, where does the bot actually end up this tick?"
// Kept free of roster/decision state so the movement model can be unit-tested
// and rewritten (Phase 2) without touching the decision loop.
//
// Behavior is preserved verbatim from the original inline simulate logic.

import type { Topology, Vec2 } from '@cm/shared';
import { wrapPosition } from '@cm/shared/topology';
import { pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';

// Exponential smoothing of the steering direction across ticks, then
// re-normalized. Damps the jitter that raw per-tick waypoint deltas produce.
// Returns a zero vector when the blended direction collapses below epsilon.
export function smoothDir(lastDir: Vec2, rawDir: Vec2, smoothing: number): Vec2 {
  const blended = {
    x: lastDir.x * smoothing + rawDir.x * (1 - smoothing),
    z: lastDir.z * smoothing + rawDir.z * (1 - smoothing),
  };
  const len = Math.hypot(blended.x, blended.z);
  if (len > 1e-3) {
    return { x: blended.x / len, z: blended.z / len };
  }
  return { x: 0, z: 0 };
}

// Attempt to move from `pos` along `dir` by `step`, sliding along walls when
// the full move is blocked. Tries three candidates in order: the full
// diagonal, then the x-axis sign only, then the z-axis sign only. The first
// unobstructed candidate wins; the result is wrapped to canonical coords for
// the topology. When every candidate is blocked, moved is false and x/z are
// the original position (the caller decides how to recover).
export function stepWithSlide(
  pos: Vec2,
  dir: Vec2,
  step: number,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
): { x: number; z: number; moved: boolean } {
  const candidates: Array<{ x: number; z: number; chosen: Vec2 }> = [
    { x: pos.x + dir.x * step, z: pos.z + dir.z * step, chosen: dir },
    { x: pos.x + Math.sign(dir.x) * step, z: pos.z, chosen: { x: Math.sign(dir.x), z: 0 } },
    { x: pos.x, z: pos.z + Math.sign(dir.z) * step, chosen: { x: 0, z: Math.sign(dir.z) } },
  ];
  for (const c of candidates) {
    if (c.chosen.x === 0 && c.chosen.z === 0) continue;
    const blocked = walls.length > 0 && pathCrossesWall(walls, pos.x, pos.z, c.x, c.z);
    if (blocked) continue;
    const wrapped = wrapPosition({ x: c.x, z: c.z }, topology, worldWidth);
    return { x: wrapped.x, z: wrapped.z, moved: true };
  }
  return { x: pos.x, z: pos.z, moved: false };
}

// Rotate `currentYaw` toward `desiredYaw` by at most maxRate*dt, taking the
// shortest angular path. Returns the new yaw.
export function turnToward(
  currentYaw: number,
  desiredYaw: number,
  maxRate: number,
  dt: number,
): number {
  let delta = desiredYaw - currentYaw;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const maxStep = maxRate * dt;
  const clamped = Math.max(-maxStep, Math.min(maxStep, delta));
  return currentYaw + clamped;
}
