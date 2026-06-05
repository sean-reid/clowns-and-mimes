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

// Deterministic head-on avoidance ("keep right" rule). Given the desired
// heading and the wrap-relative offsets to nearby other players, nudge the
// heading toward the bot's right by an amount that ramps with how close and how
// directly-ahead each neighbour is. Because every bot biases to the same side, a
// pair closing head-on veers apart symmetrically and passes, instead of
// mirroring each other's dodge into a deadlock (the "indecisive" shuffle).
//
// `offsets` are other-player positions relative to the bot (already wrap-aware),
// so this stays topology-free and ports cleanly. Only neighbours within `radius`
// and in front of the heading contribute. The lateral term is quantized to 1e-4
// for the same reason the repulsion field is: a sqrt-based value must never
// drift an outcome between the TS and GDScript bots. Returns `dir` unchanged
// when it's degenerate or no neighbour is in the forward cone, so open-field
// paths are untouched. The result is re-normalized.
export function passBiasDir(
  dir: Vec2,
  offsets: readonly Vec2[],
  radius: number,
  weight: number,
): Vec2 {
  const len = Math.hypot(dir.x, dir.z);
  if (len < 1e-3 || offsets.length === 0) return dir;
  const fwd = { x: dir.x / len, z: dir.z / len };
  // Right-hand perpendicular of the heading in the XZ plane. Consistent across
  // all bots, so two head-on bots pick opposite world sides and separate.
  const right = { x: -fwd.z, z: fwd.x };
  let lateral = 0;
  for (const off of offsets) {
    const d = Math.hypot(off.x, off.z);
    if (d < 1e-3 || d >= radius) continue;
    // Cosine of the angle between the heading and the neighbour: only those
    // ahead (dot > 0) make the bot swerve.
    const ahead = (off.x * fwd.x + off.z * fwd.z) / d;
    if (ahead <= 0) continue;
    const prox = (radius - d) / radius;
    lateral += Math.round(weight * prox * ahead * 1e4) / 1e4;
  }
  if (lateral === 0) return dir;
  const bx = fwd.x + right.x * lateral;
  const bz = fwd.z + right.z * lateral;
  const blen = Math.hypot(bx, bz);
  if (blen < 1e-3) return dir;
  return { x: bx / blen, z: bz / blen };
}

// Rotations (radians) tried, in order, to round a wall tip when the diagonal
// and both axis slides are all blocked. Each direction is the desired heading
// turned by +/- the angle; capped at 90deg so the bot slides tangent to the
// wall (wall-following) without ever retreating past it.
const CORNER_SLIDE_ANGLES = [Math.PI / 6, Math.PI / 3, Math.PI / 2];

// Attempt to move from `pos` along `dir` by `step`, sliding along walls when
// the full move is blocked. Tries, in order: the full diagonal, the x-axis sign
// only, the z-axis sign only, then progressively larger turns off the desired
// heading (both directions) to round a wall tip the axis slides can't get past.
// The first unobstructed candidate wins; the result is wrapped to canonical
// coords for the topology. When every candidate is blocked, moved is false and
// x/z are the original position (the caller decides how to recover).
export function stepWithSlide(
  pos: Vec2,
  dir: Vec2,
  step: number,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
): { x: number; z: number; moved: boolean } {
  const tryMove = (vx: number, vz: number): { x: number; z: number; moved: boolean } | null => {
    if (vx === 0 && vz === 0) return null;
    if (walls.length > 0 && pathCrossesWall(walls, pos.x, pos.z, pos.x + vx, pos.z + vz))
      return null;
    const wrapped = wrapPosition({ x: pos.x + vx, z: pos.z + vz }, topology, worldWidth);
    return { x: wrapped.x, z: wrapped.z, moved: true };
  };

  return (
    // Full diagonal, then axis-aligned slides (the original behavior).
    tryMove(dir.x * step, dir.z * step) ??
    tryMove(Math.sign(dir.x) * step, 0) ??
    tryMove(0, Math.sign(dir.z) * step) ??
    // Tip-rounding fallback: only reached when all three above are blocked.
    rotatedSlide(dir, step, tryMove) ?? { x: pos.x, z: pos.z, moved: false }
  );
}

// Try the desired heading rotated by each corner-slide angle, both directions,
// nearest turn first. Returns the first clear move, or null if none clears.
function rotatedSlide(
  dir: Vec2,
  step: number,
  tryMove: (vx: number, vz: number) => { x: number; z: number; moved: boolean } | null,
): { x: number; z: number; moved: boolean } | null {
  for (const angle of CORNER_SLIDE_ANGLES) {
    for (const sign of [1, -1]) {
      const a = sign * angle;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const vx = (dir.x * cos - dir.z * sin) * step;
      const vz = (dir.x * sin + dir.z * cos) * step;
      const r = tryMove(vx, vz);
      if (r) return r;
    }
  }
  return null;
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
