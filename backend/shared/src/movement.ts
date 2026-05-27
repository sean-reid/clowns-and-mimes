// Authoritative per-tick humanoid movement step. Identical math is used by
// the server (room.ts simulateHumans) and the client's local-player predictor.
// Both sides must call this with the same dt, inputs, and walls or
// reconciliation replay drifts from the server.

import type { PlayerState, Topology, Vec2, Vec3 } from './protocol.ts';
import { pathCrossesWall, PLAYER_RADIUS, type WallSegment } from './labyrinth.ts';
import { wrapPositionFromStep, wrappedDeltaVec } from './topology.ts';
import {
  BOUNCE_E_AERIAL,
  BOUNCE_E_GROUNDED,
  BOUNCE_E_WALL,
  HOVER_HEIGHT,
  JUMP_COOLDOWN_S,
  JUMP_DURATION_S,
  isJumping,
  jumpArcY,
  verticallyOverlapping,
} from './physics.ts';

export const WALK_SPEED = 3.2;
export const SPRINT_SPEED = 5.6;
// Anti-cheat: a single tick cannot displace a player more than this many
// units. SPRINT_SPEED * 1.5 leaves headroom for input bursts while rejecting
// teleports.
export const MAX_TICK_TRAVEL = SPRINT_SPEED * 1.5;
export const MAX_SPRINT = 100;
export const SPRINT_DRAIN_PER_S = 25;
export const SPRINT_REGEN_PER_S = 15;
// Once sprint depletes, the player has to regen past this threshold before
// sprint re-engages. Without the latch, holding shift past the 0-energy line
// oscillates between sprint and walk every tick because energy regens by
// SPRINT_REGEN_PER_S * dt > 0 each idle tick and re-arms sprint instantly.
export const SPRINT_ENGAGE_THRESHOLD = 20;

export interface MoveStepInput {
  move: Vec2;
  sprint: boolean;
  dt: number;
}

export interface MoveStepState {
  // Vec3 so the caller's Y (jump arc or HOVER_HEIGHT) survives the
  // stepMovement call. The XZ planar step is computed internally; Y is
  // copied through to the return value unchanged. Jump arc Y is driven
  // separately by physics.ts::jumpArcY at the simulate-loop level.
  position: Vec3;
  sprintEnergy: number;
  // Whether the player is currently considered to be sprinting. Set when
  // sprint engages, cleared when energy hits 0. While false, energy must
  // refill past SPRINT_ENGAGE_THRESHOLD before sprint can re-arm.
  sprinting: boolean;
}

/**
 * Predicate the server uses to reject a candidate move because it would push
 * the player into another body. The client cannot mirror this exactly without
 * knowing every other player's position at the input's tick; reconciliation
 * passes a no-op (always-false) so client prediction allows the move and lets
 * the server's snap correct it if a collision actually occurred.
 */
export type PlayerCollisionGate = (candidate: Vec2) => boolean;

/**
 * Compute one server tick of humanoid movement. Returns the next position and
 * sprint energy. Yaw is set by the caller (it is just `input.lookYaw`).
 *
 * Walls and player-collision are gates: if no candidate clears both, the
 * player stays put for this tick.
 */
export function stepMovement(
  state: MoveStepState,
  input: MoveStepInput,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  collidesWithOther: PlayerCollisionGate,
): MoveStepState {
  // Sprint hysteresis: once disengaged the player has to refill past
  // SPRINT_ENGAGE_THRESHOLD before re-engaging. While engaged any positive
  // energy keeps sprint alive. Both edges latch on state.sprinting so the
  // server and the client's reconciliation see the same truth.
  let wantSprint = false;
  if (input.sprint && state.sprintEnergy > 0) {
    wantSprint = state.sprinting ? true : state.sprintEnergy >= SPRINT_ENGAGE_THRESHOLD;
  }
  const speed = wantSprint ? SPRINT_SPEED : WALK_SPEED;
  const moveLen = Math.hypot(input.move.x, input.move.z);
  const nx = moveLen > 0 ? input.move.x / moveLen : 0;
  const nz = moveLen > 0 ? input.move.z / moveLen : 0;
  const dx = nx * speed * input.dt;
  const dz = nz * speed * input.dt;
  const travel = Math.hypot(dx, dz);
  const scale = travel > MAX_TICK_TRAVEL * input.dt ? (MAX_TICK_TRAVEL * input.dt) / travel : 1;
  const candidates: Vec2[] = [
    { x: state.position.x + dx * scale, z: state.position.z + dz * scale },
    { x: state.position.x + Math.sign(dx) * speed * input.dt, z: state.position.z },
    { x: state.position.x, z: state.position.z + Math.sign(dz) * speed * input.dt },
  ];
  // Project to XZ for the planar collision pipeline; Y is preserved on
  // the return value below regardless of which candidate wins.
  const startXZ: Vec2 = { x: state.position.x, z: state.position.z };
  let nextXZ: Vec2 = startXZ;
  for (const candidate of candidates) {
    if (candidate.x === state.position.x && candidate.z === state.position.z) continue;
    if (
      walls.length > 0 &&
      pathCrossesWall(walls, state.position.x, state.position.z, candidate.x, candidate.z)
    ) {
      continue;
    }
    if (collidesWithOther(candidate)) continue;
    // Möbius uses prev->candidate so the step can be rejected at the hard
    // z-bounds. Other topologies ignore prev.
    nextXZ = wrapPositionFromStep(startXZ, candidate, topology, worldWidth);
    break;
  }
  // Wall rebound: if the chosen candidate lost motion along an axis the
  // wall blocked, apply a tiny opposite push so the body visibly "bumps"
  // off the wall instead of dead-stopping. Compares the planned full
  // diagonal motion (candidates[0]) against what we actually moved; the
  // delta is the blocked component. With BOUNCE_E_WALL = 0.15 and
  // typical sprint speed, the bump is < 1 cm per tick - subtle, but
  // enough to read at 60 Hz. Re-check walls so a sliding rebound near a
  // corner doesn't punch through the second wall.
  const attemptedDx = candidates[0]!.x - startXZ.x;
  const attemptedDz = candidates[0]!.z - startXZ.z;
  const actualDx = nextXZ.x - startXZ.x;
  const actualDz = nextXZ.z - startXZ.z;
  const lossDx = attemptedDx - actualDx;
  const lossDz = attemptedDz - actualDz;
  const lossMag = Math.hypot(lossDx, lossDz);
  const attemptedMag = Math.hypot(attemptedDx, attemptedDz);
  if (attemptedMag > 0 && lossMag / attemptedMag > 0.1) {
    const reboundX = -lossDx * BOUNCE_E_WALL;
    const reboundZ = -lossDz * BOUNCE_E_WALL;
    const candidateXZ: Vec2 = { x: nextXZ.x + reboundX, z: nextXZ.z + reboundZ };
    const reboundBlocked =
      walls.length > 0 && pathCrossesWall(walls, nextXZ.x, nextXZ.z, candidateXZ.x, candidateXZ.z);
    if (!reboundBlocked) nextXZ = candidateXZ;
  }
  const nextPos: Vec3 = { x: nextXZ.x, y: state.position.y, z: nextXZ.z };
  const drained = wantSprint && moveLen > 0;
  const nextSprint = clamp(
    state.sprintEnergy + (drained ? -SPRINT_DRAIN_PER_S : SPRINT_REGEN_PER_S) * input.dt,
    0,
    MAX_SPRINT,
  );
  // sprinting latch: true while sprint stays alive, drops the moment we
  // hit 0. The next tick's wantSprint will need >= SPRINT_ENGAGE_THRESHOLD
  // to re-engage.
  const nextSprinting = wantSprint && nextSprint > 0;
  return { position: nextPos, sprintEnergy: nextSprint, sprinting: nextSprinting };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface JumpStepInput {
  // Rising-edge jump request (true on the input frame where the player
  // pressed Space). Holding the key does NOT chain; clients debounce.
  jump: boolean;
  // Wall-clock time the client stamped on this input (Unix ms). Used as
  // the new jumpStartedAt on trigger so the client predictor and the
  // server agree on the arc start without a round-trip. Server callers
  // should clamp into Date.now() ± 500 ms before passing in.
  nowMs: number;
}

export interface JumpStepState {
  // Null when the player is not in the jump-arc-or-cooldown lockout.
  // Set to the takeoff timestamp when a jump triggers; stays set
  // through the arc AND the post-landing cooldown so a queued
  // `jump: true` next input cannot retrigger immediately. Clears to
  // null automatically at the end of the lockout.
  jumpStartedAt: number | null;
}

export interface JumpStepResult {
  // New jumpStartedAt to write back to the player's state. Either
  // unchanged, set to `input.nowMs` on takeoff, or null after the
  // lockout expires. Y is NOT returned: the simulator's broadcast
  // path recomputes Y from jumpStartedAt at the broadcast wall-clock
  // so the snapshot's authoritative Y reflects the server's "now"
  // rather than the input's arrival time.
  jumpStartedAt: number | null;
}

/**
 * One tick of jump trigger / lockout processing. Returns the
 * authoritative jumpStartedAt to store on the player. Deterministic
 * given the same state and input; reconcile replay produces identical
 * output when the client feeds the same nowMs the server used.
 *
 * Lockout: jumpStartedAt stays set for JUMP_DURATION_S (arc) +
 * JUMP_COOLDOWN_S (post-landing). New triggers are gated on
 * jumpStartedAt === null so the cooldown sub-window naturally
 * rejects rapid re-press. During the cooldown the body is already
 * back at HOVER_HEIGHT (jumpArcY returns the floor for elapsed past
 * the arc), only the input gate remains active.
 */
export function stepJump(state: JumpStepState, input: JumpStepInput): JumpStepResult {
  const { nowMs } = input;
  let jumpStartedAt = state.jumpStartedAt;

  if (jumpStartedAt !== null) {
    const elapsedMs = nowMs - jumpStartedAt;
    const lockoutMs = (JUMP_DURATION_S + JUMP_COOLDOWN_S) * 1000;
    if (elapsedMs >= lockoutMs) {
      jumpStartedAt = null;
    }
  }

  if (input.jump && jumpStartedAt === null) {
    jumpStartedAt = nowMs;
  }

  return { jumpStartedAt };
}

/**
 * Y the body should render at given the player's authoritative
 * jumpStartedAt and the current wall-clock. Thin wrapper over
 * jumpArcY so callers can stay in this module for the full jump
 * surface.
 */
export function bodyYForState(state: { jumpStartedAt: number | null }, nowMs: number): number {
  return jumpArcY(state.jumpStartedAt, nowMs);
}

// Re-export HOVER_HEIGHT so server callers that previously imported
// movement constants can find it in the same module instead of
// reaching into physics.ts for one symbol.
export { HOVER_HEIGHT };

/**
 * Resolve player-vs-player overlaps after every player's XZ step has
 * been applied. Pushes overlapping bodies apart along their contact
 * normal AND adds a small extra-separation impulse proportional to
 * their approach speed - this is what produces the visible bounce.
 *
 * `prevPositions` is the XZ each player held at the START of this
 * tick (server holds this in a side-map; the client predictor can
 * stub with current position for bodies it does not simulate). dt is
 * the tick duration in seconds. The function mutates `players[i]`
 * positions in place; bodies whose post-push position would cross a
 * wall are left at their pre-push position so corner cases do not
 * shove anyone through geometry.
 *
 * Coefficient of restitution: BOUNCE_E_AERIAL when either body is
 * currently jumping (per physics.ts::isJumping), otherwise
 * BOUNCE_E_GROUNDED. Frozen bodies still participate (a frozen body
 * is solid; you bump off it) but do not get pushed themselves.
 */
export function resolvePlayerCollisions(
  players: PlayerState[],
  prevPositions: ReadonlyMap<string, Vec2>,
  dt: number,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  nowMs: number,
): void {
  const minSep = 2 * PLAYER_RADIUS;
  // Sort by id so the iteration order is deterministic - prevents any
  // "first iterated player wins" bias and keeps server / client
  // replay outputs bit-identical.
  const sorted = [...players].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.frozen && b.frozen) continue;
      const delta = wrappedDeltaVec(
        { x: a.position.x, z: a.position.z },
        { x: b.position.x, z: b.position.z },
        topology,
        worldWidth,
      );
      const distXZ = Math.hypot(delta.x, delta.z);
      if (distXZ >= minSep) continue;
      if (!verticallyOverlapping(a, b)) continue;
      // Normal points from a toward b. Zero-distance case: pick an
      // arbitrary deterministic direction so the math is defined.
      let nx: number;
      let nz: number;
      if (distXZ > 1e-6) {
        nx = delta.x / distXZ;
        nz = delta.z / distXZ;
      } else {
        nx = 1;
        nz = 0;
      }
      const overlap = minSep - distXZ;
      // Approach speed along the contact normal. Both prev positions
      // default to current if missing (client predictor case for
      // remote bodies it does not simulate); approach speed becomes 0
      // and only the overlap is resolved, no impulse.
      const aPrev = prevPositions.get(a.id) ?? { x: a.position.x, z: a.position.z };
      const bPrev = prevPositions.get(b.id) ?? { x: b.position.x, z: b.position.z };
      const aVx = (a.position.x - aPrev.x) / dt;
      const aVz = (a.position.z - aPrev.z) / dt;
      const bVx = (b.position.x - bPrev.x) / dt;
      const bVz = (b.position.z - bPrev.z) / dt;
      const approachAlongN = (aVx - bVx) * nx + (aVz - bVz) * nz;
      const aJumping = isJumping(a, nowMs);
      const bJumping = isJumping(b, nowMs);
      const e = aJumping || bJumping ? BOUNCE_E_AERIAL : BOUNCE_E_GROUNDED;
      const extraSep = Math.max(0, approachAlongN) * e * dt;
      const pushEach = (overlap + extraSep) / 2;
      // Frozen bodies don't get pushed (their captor expects them to
      // hold position); the other body takes the full push instead.
      const aShare = a.frozen ? 0 : b.frozen ? 2 : 1;
      const bShare = b.frozen ? 0 : a.frozen ? 2 : 1;
      const aTargetX = a.position.x - nx * pushEach * aShare;
      const aTargetZ = a.position.z - nz * pushEach * aShare;
      const bTargetX = b.position.x + nx * pushEach * bShare;
      const bTargetZ = b.position.z + nz * pushEach * bShare;
      const aBlocked =
        walls.length > 0 && pathCrossesWall(walls, a.position.x, a.position.z, aTargetX, aTargetZ);
      const bBlocked =
        walls.length > 0 && pathCrossesWall(walls, b.position.x, b.position.z, bTargetX, bTargetZ);
      if (aShare > 0 && !aBlocked) {
        a.position = { x: aTargetX, y: a.position.y, z: aTargetZ };
      }
      if (bShare > 0 && !bBlocked) {
        b.position = { x: bTargetX, y: b.position.y, z: bTargetZ };
      }
    }
  }
}
