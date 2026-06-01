// Game simulation extracted from room.ts under Phase B2 of the
// file-split plan. Owns the per-tick loop: pause/resume handling,
// turn rotation, human input application, bot delegation, idle jump
// arc maintenance, post-tick collision resolution, and per-tick
// position-history recording.
//
// Behavior is preserved verbatim from the original room.ts methods;
// the Phase A1 simulate fixture covers the human side and continues
// to pass.

import type {
  PlayerInput,
  PlayerState,
  RoomPhase,
  ServerToClient,
  Team,
  Topology,
} from '@cm/shared';
import { BATTLE_CRY_COUNT } from '@cm/shared';
import { JUMP_COOLDOWN_S, JUMP_DURATION_S } from '@cm/shared/physics';
import {
  bodyYForState,
  resolvePlayerCollisions,
  stepJump,
  stepMovement,
} from '@cm/shared/movement';
import type { WallSegment } from '@cm/shared/labyrinth';

// World half-extent (Room owns the canonical constant; we mirror it here).
const WORLD_WIDTH = 80;
// Tick cadence — must match Room's TICK_HZ.
const TICK_HZ = 60;
const TICK_MS = 1000 / TICK_HZ;
// Turn rotation timing.
const TURN_FIRST_MS = 30_000;
const TURN_STEP_MS = 30_000;
const TURN_CAP_MS = 5 * 60_000;
// Bound on client clock skew when stamping jump arc starts.
const JUMP_CLIENT_CLOCK_SKEW_MS = 500;
// How long lag-comp history is retained per player.
const POSITION_HISTORY_KEEP_MS = 500;
// Max inputs applied per player per tick. The client sends ~60/s; this lets
// a tick that ran late drain its backlog and keep ackSeq current, while
// capping how far a banked-input burst can advance a player in one tick
// (anti-warp). 6 covers a tick spaced ~100 ms apart and drains a 2 s stall
// (~120 inputs) in well under a second once ticks resume.
const MAX_INPUTS_PER_TICK = 6;

/**
 * State the simulation reads and writes. Maps are exposed by reference
 * because the simulation mutates them in place every tick; phase and
 * turnEndsAt go through getters/setters because they change on turn
 * transitions and pause/resume.
 */
export interface GameSimulationHost {
  readonly players: Map<string, PlayerState>;
  readonly inputQueues: Map<string, PlayerInput[]>;
  readonly lastAppliedSeq: Map<string, number>;
  readonly prevTickPositions: Map<string, { x: number; z: number }>;
  readonly positionHistory: Map<string, Array<{ t: number; x: number; z: number }>>;
  getWalls(): readonly WallSegment[];
  getTopology(): Topology;
  getPhase(): RoomPhase;
  setPhase(p: RoomPhase): void;
  getTurnEndsAt(): number;
  setTurnEndsAt(ms: number): void;
  getFirstTeam(): Team;
  getRoundNumber(): number;
  incrementRoundNumber(): void;
  activeHumans(): number;
  simulateBots(dt: number): void;
  stepProjectiles(dt: number): void;
  stepItems(dt: number): void;
  broadcast(msg: ServerToClient): void;
  broadcastDelta(): void;
}

export class GameSimulation {
  // Wall-clock when the world was paused. Null while running. Set on the
  // first tick where activeHumans() drops to 0; cleared on the first tick
  // after a human reconnects (which also shifts turnEndsAt forward by
  // the pause duration).
  private pausedSince: number | null = null;

  constructor(private readonly host: GameSimulationHost) {}

  /**
   * Top-level tick. Called from the Room's setInterval callback at
   * TICK_HZ. Pauses while no humans are connected, rotates turns when
   * the clock expires, runs the simulation, broadcasts the delta.
   */
  tick(): void {
    // Pause the world while every human is in the session-token grace
    // window. Multi-human matches stay unaffected: as long as one human
    // is connected, activeHumans > 0 and the tick runs normally.
    if (this.host.activeHumans() === 0) {
      if (this.pausedSince === null) this.pausedSince = Date.now();
      return;
    }
    if (this.pausedSince !== null) {
      // First tick after a resume - shift the turn clock forward so a
      // returning player doesn't find their turn already half-over.
      this.host.setTurnEndsAt(this.host.getTurnEndsAt() + (Date.now() - this.pausedSince));
      this.pausedSince = null;
    }
    const now = Date.now();
    const phase = this.host.getPhase();
    if (phase === 'free_roam' && now >= this.host.getTurnEndsAt()) {
      this.beginNextTurn();
    } else if (
      (phase === 'turn_mime' || phase === 'turn_clown') &&
      now >= this.host.getTurnEndsAt()
    ) {
      this.beginNextTurn();
    }
    this.simulate();
    this.host.broadcastDelta();
  }

  /**
   * Advance phase to the next team's turn and broadcast a phase event
   * with a server-picked battle-cry index.
   */
  beginNextTurn(): void {
    this.host.incrementRoundNumber();
    const phase = this.host.getPhase();
    const next: Team =
      phase === 'turn_mime' ? 'clown' : phase === 'turn_clown' ? 'mime' : this.host.getFirstTeam();
    const nextPhase = `turn_${next}` as RoomPhase;
    this.host.setPhase(nextPhase);
    const ms = Math.min(
      TURN_CAP_MS,
      TURN_FIRST_MS + (this.host.getRoundNumber() - 1) * TURN_STEP_MS,
    );
    this.host.setTurnEndsAt(Date.now() + ms);
    const cryIndex = Math.floor(Math.random() * BATTLE_CRY_COUNT);
    this.host.broadcast({ t: 'event', kind: { kind: 'phase', phase: nextPhase, cryIndex } });
  }

  /**
   * Apply human inputs, run bot AI, advance idle jumps, resolve overlap
   * with bounceback, refresh prev positions, append to lag-comp history.
   * Public so test fixtures can drive it without going through tick().
   */
  simulate(): void {
    const dt = TICK_MS / 1000;
    this.simulateHumans(dt);
    this.host.simulateBots(dt);
    this.advanceIdleJumpState();
    // After every player has moved this tick, resolve any overlap +
    // apply bounceback. Runs once per tick so impulses are bounded.
    resolvePlayerCollisions(
      [...this.host.players.values()],
      this.host.prevTickPositions,
      dt,
      this.host.getWalls(),
      this.host.getTopology(),
      WORLD_WIDTH,
      Date.now(),
    );
    // Refresh prev positions AFTER bounceback so next tick's approach
    // velocity reflects the post-bounce stance, not the pre-bounce
    // overlap that would otherwise show up as a phantom impulse.
    this.host.prevTickPositions.clear();
    for (const p of this.host.players.values()) {
      this.host.prevTickPositions.set(p.id, { x: p.position.x, z: p.position.z });
    }
    this.recordPositionsForLagComp();
    // Advance in-flight projectiles after players have settled this tick
    // so hit tests run against post-collision positions. Freezes apply
    // through the same tagged path; the next broadcastDelta carries the
    // updated projectile set.
    this.host.stepProjectiles(dt);
    // Item respawn timers + pickup-on-touch run against post-collision
    // positions too. Pickups/respawns broadcast as events; the static
    // item set rides the snapshot, not the delta.
    this.host.stepItems(dt);
  }

  /**
   * Refresh Y and clear stale jumpStartedAt for every player whose
   * stepJump did not run this tick. Without this pass, a mid-air
   * player whose inputs stopped landing would have its jumpStartedAt
   * sit at the takeoff timestamp indefinitely and the broadcast
   * snapshot's position.y would stay stale.
   */
  private advanceIdleJumpState(): void {
    const now = Date.now();
    const lockoutMs = (JUMP_DURATION_S + JUMP_COOLDOWN_S) * 1000;
    for (const p of this.host.players.values()) {
      if (p.jumpStartedAt !== null && now - p.jumpStartedAt >= lockoutMs) {
        p.jumpStartedAt = null;
        p.leaping = false;
      }
      p.position = {
        x: p.position.x,
        y: bodyYForState({ jumpStartedAt: p.jumpStartedAt, leaping: p.leaping }, now),
        z: p.position.z,
      };
    }
  }

  /**
   * Append every player's current position to their history ring.
   * tagRules later rewinds by LAG_COMP_MS so the server validates
   * against the world state the client saw at the moment of the tag.
   */
  private recordPositionsForLagComp(): void {
    const now = Date.now();
    const cutoff = now - POSITION_HISTORY_KEEP_MS;
    for (const p of this.host.players.values()) {
      let hist = this.host.positionHistory.get(p.id);
      if (!hist) {
        hist = [];
        this.host.positionHistory.set(p.id, hist);
      }
      hist.push({ t: now, x: p.position.x, z: p.position.z });
      while (hist.length > 0 && hist[0]!.t < cutoff) hist.shift();
    }
  }

  /** Closest historical position at or before atMs, or current if missing. */
  positionAt(playerId: string, atMs: number): { x: number; z: number } {
    const hist = this.host.positionHistory.get(playerId);
    if (hist && hist.length > 0) {
      for (let i = hist.length - 1; i >= 0; i -= 1) {
        if (hist[i]!.t <= atMs) return { x: hist[i]!.x, z: hist[i]!.z };
      }
    }
    const p = this.host.players.get(playerId);
    return p ? { x: p.position.x, z: p.position.z } : { x: 0, z: 0 };
  }

  /**
   * Drain at most one input per player per tick (oldest first) and
   * apply via stepMovement + stepJump. Bot / frozen / missing players
   * have their queues drained without applying.
   */
  private simulateHumans(_dt: number): void {
    const walls = this.host.getWalls();
    const topology = this.host.getTopology();
    for (const [id, q] of this.host.inputQueues) {
      if (q.length === 0) continue;
      const p = this.host.players.get(id);
      if (!p || p.bot || p.frozen) {
        // Ineligible player: drain the queue so reconnects or thaws start
        // from a clean slate instead of replaying stale inputs. Still
        // advance lastAppliedSeq to the highest seq we drained so the
        // next delta's ackSeq lets the client prune its pending_inputs
        // buffer. Without this, a frozen player's client keeps streaming
        // ~60 inputs/s with no ACK, the buffer grows unboundedly, and
        // every delta's reconcile() replays N inputs through stepMovement
        // - process time hit 195ms (5fps) in a playtest with N=3800.
        const highestQueued = q[q.length - 1]?.seq;
        if (highestQueued !== undefined) {
          const lastSeq = this.host.lastAppliedSeq.get(id) ?? -1;
          if (highestQueued > lastSeq) {
            this.host.lastAppliedSeq.set(id, highestQueued);
          }
        }
        q.length = 0;
        continue;
      }
      // Drain the input backlog this tick (oldest first), bounded by
      // MAX_INPUTS_PER_TICK. The client streams at TICK_HZ, but the DO's
      // setInterval cannot hold a precise 60 Hz on Cloudflare (~45-54/s with
      // multi-second pauses on I/O turns), so a one-in-one-out drain lets the
      // queue overflow and silently drop inputs the client already predicted;
      // lastAppliedSeq then jumps past the dropped seqs and the client's
      // authoritative base snaps backward (the "backstep"). Applying the
      // backlog keeps lastAppliedSeq in step with what the client actually
      // sent, so reconcile() replays from a correct base regardless of tick
      // jitter. The per-tick cap bounds replay cost and prevents a client
      // from banking inputs for a single-tick time-warp burst.
      let applied = 0;
      while (q.length > 0 && applied < MAX_INPUTS_PER_TICK) {
        const input = q.shift()!;
        const lastSeq = this.host.lastAppliedSeq.get(id) ?? -1;
        if (input.seq <= lastSeq) continue;
        // Clamp the client's input timestamp to local clock skew. Used both as
        // the jump arc start (below) and the surge-active test, so the client
        // predictor and the server resolve both off the same stamp.
        const serverNow = Date.now();
        const inputNow = input.nowMs ?? serverNow;
        const skewMs = Math.abs(inputNow - serverNow);
        const arcNow = skewMs > JUMP_CLIENT_CLOCK_SKEW_MS ? serverNow : inputNow;
        const next = stepMovement(
          { position: p.position, sprintEnergy: p.sprintEnergy, sprinting: p.sprinting },
          // Use the dt the client reported with this input, not the server's
          // tick dt. Reconciliation replay on the client also drives
          // stepMovement from input.dt; divergence would drift the replayed
          // position from the server's authoritative result.
          {
            move: input.move,
            sprint: input.sprint,
            dt: input.dt,
            surge: (p.surgeUntil ?? 0) > arcNow,
          },
          walls,
          topology,
          WORLD_WIDTH,
          // No collision gate here: resolvePlayerCollisions in the
          // post-step pass handles overlap by pushing bodies apart and
          // adding the bounceback impulse.
          () => false,
        );
        // Jump trigger / lockout. The client stamps input.nowMs when it
        // sends; we use that timestamp (clamped to local clock skew) as
        // the new jumpStartedAt so the client's predicted arc start
        // matches the authoritative value without a round-trip.
        const jump = stepJump(
          { jumpStartedAt: p.jumpStartedAt },
          { jump: input.jump ?? false, nowMs: arcNow },
        );
        // Leap: a fresh trigger (new non-null takeoff) consumes a banked
        // leapArmed flag and marks this arc as a leap. leaping persists
        // through the arc and clears when the lockout ends below.
        const freshTrigger = jump.jumpStartedAt !== null && jump.jumpStartedAt !== p.jumpStartedAt;
        if (freshTrigger && p.leapArmed) {
          p.leaping = true;
          p.leapArmed = false;
        }
        p.position = next.position;
        p.jumpStartedAt = jump.jumpStartedAt;
        if (jump.jumpStartedAt === null) p.leaping = false;
        p.sprintEnergy = next.sprintEnergy;
        p.sprinting = next.sprinting;
        p.yaw = input.lookYaw;
        p.pitch = input.lookPitch ?? 0;
        this.host.lastAppliedSeq.set(id, input.seq);
        applied++;
      }
    }
  }
}
