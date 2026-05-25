// Authoritative per-tick humanoid movement step. Identical math is used by
// the server (room.ts simulateHumans) and the client's local-player predictor.
// Both sides must call this with the same dt, inputs, and walls or
// reconciliation replay drifts from the server.

import type { Topology, Vec2 } from './protocol.ts';
import { pathCrossesWall, type WallSegment } from './labyrinth.ts';
import { wrapPositionFromStep } from './topology.ts';

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
  position: Vec2;
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
  let nextPos = state.position;
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
    nextPos = wrapPositionFromStep(state.position, candidate, topology, worldWidth);
    break;
  }
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
