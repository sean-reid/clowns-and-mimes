// Bot AI extracted from room.ts under Phase B1 of the file-split plan.
// Owns the BotMind state map + the bot fill / simulation loop +
// patrol/exploration helpers. Hosts via a BotManagerHost interface so
// Room (and tests) can supply the surrounding state without exposing
// the whole DurableObject.
//
// Behavior preserved verbatim from the original room.ts methods; the
// Phase A1 simulate fixture regression-tests the human side, and new
// tests in this file cover the bot-specific paths.

import type {
  ItemType,
  PlayerState,
  Projectile,
  ServerToClient,
  Team,
  Topology,
  Vec2,
  Vec3,
} from '@cm/shared';
import {
  topologyDistance,
  wrapPosition,
  wrappedDeltaVec,
  wrappedUnitDelta,
} from '@cm/shared/topology';
import { pathCrossesWall, pointBlockedByWall, type WallSegment } from '@cm/shared/labyrinth';
import { generateRandomName } from '@cm/shared/names';
import {
  MAX_SPRINT,
  SPRINT_DRAIN_PER_S,
  SPRINT_REGEN_PER_S,
  SPRINT_SPEED,
  WALK_SPEED,
} from '@cm/shared/movement';
import { PROJECTILE_SPEED } from '@cm/shared/projectiles';
import {
  BOT_CHASE_FLANK_RADIUS,
  BOT_CHASE_FLANK_RELEASE_DIST,
  BOT_DODGE_LEAD_S,
  BOT_DODGE_RADIUS,
  BOT_FIRE_THREAT_LOOKBACK,
  BOT_FLEE_PROJECTION,
  BOT_INVESTIGATE_MS,
  BOT_ITEM_SEEK_RADIUS,
  BOT_JUMP_CORNER_THREAT_RADIUS,
  BOT_JUMP_EVADE_BUFFER,
  BOT_JUMP_NOISE_PER_SECOND,
  BOT_JUMP_REFRACTORY_MS,
  BOT_NO_PROGRESS_MIN_DIST,
  BOT_NO_PROGRESS_WINDOW_MS,
  BOT_PATROL_CANDIDATE_ATTEMPTS,
  BOT_PATROL_MOMENTUM_BONUS,
  BOT_PATROL_RETARGET_MS,
  BOT_PATROL_SPREAD_RADIUS,
  BOT_PATROL_SPREAD_WEIGHT,
  BOT_PATROL_VISIT_DECAY_MS,
  BOT_SHOOT_AIM_JITTER,
  BOT_SHOOT_RANGE,
  BOT_SPRINT_TRIGGER_RADIUS,
  BOT_VISION_RADIUS,
  CLONE_DURATION_MS,
  CLONE_SPAWN_OFFSET,
  DIR_SMOOTHING,
  MAX_YAW_RATE,
  RETARGET_HYSTERESIS,
  TAG_RADIUS_BOT,
  UNFREEZE_RADIUS_BOT,
} from '@cm/shared/botTuning';
import type { BotPathfinder } from './botPathfinder.ts';
import { smoothDir, stepWithSlide, turnToward } from './botSteering.ts';
import { decideBotAction } from './botDecision.ts';
import { decideItemUse } from './botItems.ts';
import { nearestEnemy } from './botPerception.ts';
import { nearestItemTarget, portalEscapeTarget } from './botGoals.ts';
import { assignChases, assignRescues } from './botCoordination.ts';
import { bestFleeTarget } from './botFlee.ts';
import { interceptPoint } from './botIntercept.ts';
import { nearestProjectileThreat, shouldDodgeProjectile } from './botProjectileThreat.ts';
import { markVisited, patrolCandidateScore, type ExplorationParams } from './botExploration.ts';

// World half-extent (kept private here; Room owns the canonical constant).
const WORLD_WIDTH = 80;

const EXPLORATION_PARAMS: ExplorationParams = {
  decayMs: BOT_PATROL_VISIT_DECAY_MS,
  momentumBonus: BOT_PATROL_MOMENTUM_BONUS,
  spreadRadius: BOT_PATROL_SPREAD_RADIUS,
  spreadWeight: BOT_PATROL_SPREAD_WEIGHT,
};

// Server-only bot orchestration (slot fill). The behavioral tuning lives in
// @cm/shared/botTuning so the offline GDScript brain reads the same values.
const TEAM_TARGET = 4;
const BOT_FILL_DELAY_MS = 3_000;

interface BotMind {
  patrolTarget: { x: number; z: number };
  patrolUntil: number;
  engagedTargetId: string | null;
  lastDir: { x: number; z: number };
  lastYaw: number;
  progressSampleAt: number;
  progressSamplePos: { x: number; z: number };
  lastKnownPos: { x: number; z: number } | null;
  investigateUntil: number;
  // Coarse visit grid (cell -> last-visited ms) for coverage-aware patrol, so
  // the bot favors stale corners of the map over re-treading one spot. Replaces
  // the old recentTargets rejection (this subsumes it).
  visited: Map<number, number>;
  lastJumpedAt: number;
  // Fixed per-bot jitter in [0,1) that staggers the deterministic jump
  // triggers, so two bots in the same situation don't take off on the exact
  // same tick (the reactive evade / no-progress jumps would otherwise fire
  // simultaneously across a cluster).
  jumpPhase: number;
  // Last tick's engaged-target id + position + time, to derive the target's
  // velocity for predictive aim / interception. Cleared implicitly when the
  // target id changes (a fresh id yields zero velocity until the next tick).
  aimPrevId: string | null;
  aimPrevPos: { x: number; z: number } | null;
  aimPrevAt: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function nearTarget(
  from: { x: number; z: number },
  to: { x: number; z: number },
  threshold = 1.4,
): boolean {
  return Math.hypot(to.x - from.x, to.z - from.z) <= threshold;
}

/**
 * Host surface for the bot AI. Read-only access via getters where the
 * value can change (walls/topology/phase/pathfinder); the in-place
 * mutated Maps (players, lastSavedAt) are exposed by reference.
 */
export interface BotManagerHost {
  readonly players: Map<string, PlayerState>;
  readonly lastSavedAt: Map<string, number>;
  getWalls(): readonly WallSegment[];
  getTopology(): Topology;
  getPathfinder(): BotPathfinder | null;
  getActiveTurnTeam(): Team | null;
  getPhase(): string;
  getTickHandle(): unknown;
  pickSpawnPosition(team: Team): Vec3;
  tally(team: Team): number;
  humanCount(): number;
  botCount(): number;
  notifyMatchmaker(humans: number, bots: number): void;
  broadcast(msg: ServerToClient): void;
  canTag(attacker: PlayerState, victim: PlayerState, radius: number): boolean;
  freezePlayer(p: PlayerState): void;
  checkWin(): void;
  startMatch(): void;
  // Fire a projectile on the bot's behalf; returns whether it launched.
  botShoot(attacker: PlayerState, dir: Vec3): boolean;
  // Activate the bot's held power-up (clears the slot, applies the effect).
  useBotItem(player: PlayerState): void;
  // Floor items currently available to pick up.
  availableItems(): readonly { type: ItemType; position: Vec3 }[];
  // Entry/exit mouths of a live portal this player opened, or null.
  botPortalEntry(playerId: string): { a: Vec3; b: Vec3 } | null;
  // Live projectiles, so a bot can "hear" recent enemy shots.
  getProjectiles(): readonly Projectile[];
}

export class BotManager {
  private readonly botMinds = new Map<string, BotMind>();
  private botFillHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: BotManagerHost) {}

  hasBot(id: string): boolean {
    return this.botMinds.has(id);
  }

  /** Schedule fillBots + startMatch after BOT_FILL_DELAY_MS. */
  scheduleFill(): void {
    this.botFillHandle = setTimeout(() => {
      this.botFillHandle = null;
      if (this.host.getPhase() !== 'filling' || this.host.getTickHandle()) return;
      this.fillTeams();
      this.host.startMatch();
    }, BOT_FILL_DELAY_MS);
  }

  cancelFill(): void {
    if (this.botFillHandle !== null) {
      clearTimeout(this.botFillHandle);
      this.botFillHandle = null;
    }
  }

  /** Fill empty slots with bots up to TEAM_TARGET per team. Idempotent. */
  fillTeams(): void {
    for (const team of ['mime', 'clown'] as const) {
      while (this.host.tally(team) < TEAM_TARGET) {
        const id = crypto.randomUUID();
        const spawn = this.host.pickSpawnPosition(team);
        this.host.players.set(id, {
          id,
          name: generateRandomName(),
          team,
          bot: true,
          position: spawn,
          yaw: 0,
          frozen: false,
          sprintEnergy: MAX_SPRINT,
          sprinting: false,
          jumpStartedAt: null,
        });
        this.botMinds.set(id, this.freshMind(spawn, 0));
      }
    }
    this.host.notifyMatchmaker(this.host.humanCount(), this.host.botCount());
  }

  /**
   * Spawn a Clone power-up's temporary ally: a bot on the owner's team,
   * placed next to them, that despawns after CLONE_DURATION_MS. It rides the
   * snapshot like any other player, so no event is needed; cloneExpiresAt on
   * its PlayerState both schedules the despawn and survives persistence.
   */
  spawnClone(owner: PlayerState): void {
    const id = crypto.randomUUID();
    const spawn = this.cloneSpawnNear(owner);
    this.host.players.set(id, {
      id,
      name: generateRandomName(),
      team: owner.team,
      bot: true,
      position: spawn,
      yaw: owner.yaw,
      frozen: false,
      sprintEnergy: MAX_SPRINT,
      sprinting: false,
      jumpStartedAt: null,
      cloneExpiresAt: Date.now() + CLONE_DURATION_MS,
    });
    this.botMinds.set(id, this.freshMind(spawn, owner.yaw));
    this.host.notifyMatchmaker(this.host.humanCount(), this.host.botCount());
  }

  private freshMind(pos: { x: number; z: number }, yaw: number): BotMind {
    return {
      patrolTarget: this.randomPatrolPoint(),
      patrolUntil: 0,
      engagedTargetId: null,
      lastDir: { x: 0, z: 0 },
      lastYaw: yaw,
      progressSampleAt: Date.now(),
      progressSamplePos: { x: pos.x, z: pos.z },
      lastKnownPos: null,
      investigateUntil: 0,
      visited: new Map(),
      lastJumpedAt: 0,
      jumpPhase: Math.random(),
      aimPrevId: null,
      aimPrevPos: null,
      aimPrevAt: 0,
    };
  }

  // First bearing around the owner at CLONE_SPAWN_OFFSET that doesn't land in
  // a wall; falls back to the owner's own cell if every bearing is blocked.
  private cloneSpawnNear(owner: PlayerState): Vec3 {
    const walls = this.host.getWalls();
    const topology = this.host.getTopology();
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * 2 * Math.PI;
      const raw = {
        x: owner.position.x + Math.cos(a) * CLONE_SPAWN_OFFSET,
        z: owner.position.z + Math.sin(a) * CLONE_SPAWN_OFFSET,
      };
      const w = wrapPosition(raw, topology, WORLD_WIDTH);
      if (walls.length === 0 || !pointBlockedByWall(walls, w.x, w.z)) {
        return { x: w.x, y: owner.position.y, z: w.z };
      }
    }
    return { x: owner.position.x, y: owner.position.y, z: owner.position.z };
  }

  // Despawn clones whose lifetime elapsed. Runs at the top of each bot tick.
  // Re-checks win state because a team can lose its last standing member when
  // a clone that was propping it up expires.
  private sweepExpiredClones(now: number): void {
    let removed = false;
    for (const [id, p] of this.host.players) {
      if (p.cloneExpiresAt !== undefined && p.cloneExpiresAt <= now) {
        this.host.players.delete(id);
        this.botMinds.delete(id);
        this.host.lastSavedAt.delete(id);
        removed = true;
      }
    }
    if (removed) {
      this.host.notifyMatchmaker(this.host.humanCount(), this.host.botCount());
      this.host.checkWin();
    }
  }

  /** Drop all bots. Called on detach when no humans remain. */
  clear(): void {
    for (const id of [...this.botMinds.keys()]) {
      this.host.players.delete(id);
    }
    this.botMinds.clear();
  }

  /** Drop one bot from the given team and clean up mind state. */
  kickOneFromTeam(team: Team): void {
    for (const [id, p] of this.host.players) {
      if (p.team === team && p.bot) {
        this.host.players.delete(id);
        this.botMinds.delete(id);
        this.host.lastSavedAt.delete(id);
        this.host.notifyMatchmaker(this.host.humanCount(), this.host.botCount());
        return;
      }
    }
  }

  /** Called when a bot disconnects / is removed - drop its mind state. */
  forget(playerId: string): void {
    this.botMinds.delete(playerId);
  }

  private randomPatrolPoint(): { x: number; z: number } {
    // A random pathfinder cell center spans the whole topology grid (incl.
    // Klein's double cover / Möbius extents), so bots explore the full map.
    const pathfinder = this.host.getPathfinder();
    if (pathfinder) {
      const c = pathfinder.cellCenterAt(Math.floor(Math.random() * pathfinder.cellCount()));
      return { x: c.x, z: c.z };
    }
    // No maze: fall back to a random point in the canonical box.
    const half = WORLD_WIDTH / 2;
    return {
      x: (Math.random() - 0.5) * 2 * (half - 4),
      z: (Math.random() - 0.5) * 2 * (half - 4),
    };
  }

  // Pick the next patrol point: sample candidates and keep the highest-scoring
  // by coverage (least-recently-visited cell) + heading momentum, skipping
  // wall-blocked ones. Sweeps the map instead of pacing one spot.
  private pickExplorationPatrolPoint(
    mind: BotMind,
    bot: PlayerState,
    now: number,
  ): {
    x: number;
    z: number;
  } {
    const walls = this.host.getWalls();
    const pathfinder = this.host.getPathfinder();
    // Same-team players to spread away from (so the team covers distinct regions).
    const teammates: Vec2[] = [];
    for (const other of this.host.players.values()) {
      if (other.id !== bot.id && other.team === bot.team) {
        teammates.push({ x: other.position.x, z: other.position.z });
      }
    }
    let best = this.randomPatrolPoint();
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < BOT_PATROL_CANDIDATE_ATTEMPTS; attempt += 1) {
      const candidate = this.randomPatrolPoint();
      if (walls.length > 0 && pointBlockedByWall(walls, candidate.x, candidate.z)) continue;
      const cell = pathfinder ? pathfinder.cellAt(candidate) : -1;
      const score = patrolCandidateScore(
        candidate,
        cell,
        bot.position,
        mind.lastDir,
        mind.visited,
        now,
        EXPLORATION_PARAMS,
        teammates,
      );
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  private commitPatrolTarget(mind: BotMind, bot: PlayerState, now: number): void {
    mind.patrolTarget = this.pickExplorationPatrolPoint(mind, bot, now);
  }

  // Positions of every other player (both teams) for the pathfinder's dynamic
  // player-repulsion field, so a bot routes around teammates and enemies alike.
  // No target is excluded here: the pathfinder never penalizes the destination
  // cell, so a chase / rescue target staying reachable is handled there.
  private avoidPositionsForBot(self: PlayerState): Vec2[] {
    const out: Vec2[] = [];
    for (const other of this.host.players.values()) {
      if (other.id === self.id) continue;
      out.push({ x: other.position.x, z: other.position.z });
    }
    return out;
  }

  /**
   * One bot-AI tick. Drives chase / flee / rescue / patrol decisions,
   * applies movement with slide fallback, fires jumps when one of the
   * three triggers latches, and resolves bot tag + rescue actions.
   * Behavior preserved verbatim from room.ts::simulateBots.
   */
  simulate(dt: number): void {
    const active = this.host.getActiveTurnTeam();
    const now = Date.now();
    this.sweepExpiredClones(now);
    const topology = this.host.getTopology();
    const walls = this.host.getWalls();
    const pathfinder = this.host.getPathfinder();
    // One rescue claim per frozen teammate, so bots spread across distinct
    // allies instead of swarming the nearest one. Computed once per tick.
    const rescueClaims = assignRescues(
      this.host.players.values(),
      topology,
      WORLD_WIDTH,
      BOT_VISION_RADIUS,
    );
    // One pincer slot per bot sharing a chase target, so a pack fans out around
    // the enemy instead of conga-lining in. Computed once per tick.
    const chaseClaims = assignChases(
      this.host.players.values(),
      walls,
      topology,
      WORLD_WIDTH,
      now,
      BOT_VISION_RADIUS,
      BOT_CHASE_FLANK_RADIUS,
    );
    // Live projectiles this tick, so an idle bot can hear recent enemy fire.
    const projectiles = this.host.getProjectiles();

    for (const bot of this.botPlayers()) {
      if (bot.frozen) continue;
      const mind = this.botMinds.get(bot.id) ?? {
        patrolTarget: this.randomPatrolPoint(),
        patrolUntil: 0,
        engagedTargetId: null,
        lastDir: { x: 0, z: 0 },
        lastYaw: bot.yaw,
        progressSampleAt: now,
        progressSamplePos: { x: bot.position.x, z: bot.position.z },
        lastKnownPos: null,
        investigateUntil: 0,
        visited: new Map(),
        lastJumpedAt: 0,
        jumpPhase: Math.random(),
        aimPrevId: null,
        aimPrevPos: null,
        aimPrevAt: 0,
      };
      this.botMinds.set(bot.id, mind);
      // Record the bot's current cell this tick so patrol can favor stale ones.
      if (pathfinder) markVisited(mind.visited, pathfinder.cellAt(bot.position), now);

      // Seen incoming fire: shots only come from the active hunter, so a visible
      // enemy projectile means this bot is the prey. If it can't see the hunter
      // (no target to flee) it can still see the shot and flee away from the line
      // it came along - used below only when it has nothing visible to act on.
      // Don't distract a bot already locked onto someone.
      const fireThreat = mind.engagedTargetId
        ? null
        : nearestProjectileThreat(
            bot,
            projectiles,
            walls,
            topology,
            WORLD_WIDTH,
            BOT_VISION_RADIUS,
            BOT_FIRE_THREAT_LOOKBACK,
          );

      // A held item blocks pickup, so only seek floor items when empty-handed.
      const collectTarget =
        bot.activeItem === undefined
          ? nearestItemTarget(
              bot.position,
              this.host.availableItems(),
              topology,
              WORLD_WIDTH,
              BOT_ITEM_SEEK_RADIUS,
            )
          : null;

      const decision = decideBotAction(
        bot,
        this.host.players.values(),
        walls,
        topology,
        WORLD_WIDTH,
        now,
        active,
        mind,
        {
          visionRadius: BOT_VISION_RADIUS,
          shootRange: BOT_SHOOT_RANGE,
          retargetHysteresis: RETARGET_HYSTERESIS,
          investigateMs: BOT_INVESTIGATE_MS,
        },
        collectTarget,
        rescueClaims.get(bot.id) ?? null,
      );
      const { target, enemyDist, rescueTarget, rescueDist, chasing, fleeing, rescuing, canShoot } =
        decision;

      // Derive the engaged target's velocity from its move since last tick, for
      // predictive aim + interception. A fresh target id (or first sighting)
      // yields zero velocity, so the lead only applies once we have two samples.
      let targetVel = { x: 0, z: 0 };
      if (target) {
        if (mind.aimPrevId === target.id && mind.aimPrevPos && now > mind.aimPrevAt) {
          const dtSec = (now - mind.aimPrevAt) / 1000;
          const d = wrappedDeltaVec(mind.aimPrevPos, target.position, topology, WORLD_WIDTH);
          targetVel = { x: d.x / dtSec, z: d.z / dtSec };
        }
        mind.aimPrevId = target.id;
        mind.aimPrevPos = { x: target.position.x, z: target.position.z };
        mind.aimPrevAt = now;
      } else {
        mind.aimPrevId = null;
        mind.aimPrevPos = null;
      }

      const sinceLastJump = now - mind.lastJumpedAt;
      const jumpEligible = bot.jumpStartedAt === null && sinceLastJump >= BOT_JUMP_REFRACTORY_MS;
      let wantJump = false;
      if (jumpEligible) {
        // Per-bot jitter so a cluster reacting to the same threat doesn't take
        // off on one tick: the evade range and the no-progress window each vary
        // a little per bot (jumpPhase in [0,1)).
        const evadeBuffer = BOT_JUMP_EVADE_BUFFER * (0.5 + mind.jumpPhase);
        const noProgressWindow = BOT_NO_PROGRESS_WINDOW_MS * (0.75 + 0.5 * mind.jumpPhase);
        // Dodge first: a shot about to hit is the most urgent reason to jump.
        if (
          shouldDodgeProjectile(
            bot,
            projectiles,
            walls,
            topology,
            WORLD_WIDTH,
            BOT_DODGE_RADIUS,
            BOT_DODGE_LEAD_S,
          )
        ) {
          wantJump = true;
        }
        if (
          !wantJump &&
          fleeing &&
          target !== null &&
          !target.frozen &&
          target.jumpStartedAt === null &&
          enemyDist <= TAG_RADIUS_BOT + evadeBuffer
        ) {
          wantJump = true;
        }
        if (!wantJump) {
          const noProgressDur = now - mind.progressSampleAt;
          if (noProgressDur >= noProgressWindow && enemyDist <= BOT_JUMP_CORNER_THREAT_RADIUS) {
            wantJump = true;
          }
        }
        if (!wantJump && chasing) {
          if (Math.random() < BOT_JUMP_NOISE_PER_SECOND * dt) {
            wantJump = true;
          }
        }
      }
      // Power-up use is decided before the jump applies so a Leap arms the
      // very jump this tick. Other effects (surge / overcharge / cloak / clone
      // / portal) take hold immediately; radar, instead of being dumped, is
      // held until the bot is blind to every actionable enemy and then spent to
      // seed investigate memory toward the nearest one (applied next tick).
      if (bot.activeItem !== undefined) {
        const hasActionableEnemy = target !== null && enemyDist < BOT_VISION_RADIUS;
        const ping = hasActionableEnemy
          ? null
          : (nearestEnemy(bot, this.host.players.values(), topology, WORLD_WIDTH).target
              ?.position ?? null);
        const itemDecision = decideItemUse(
          bot.activeItem,
          {
            chasing,
            fleeing: fleeing === true,
            wantJump,
            canShoot,
            enemyDist,
            sprintEnergy: bot.sprintEnergy,
            hasActionableEnemy,
            nearestEnemyPos: ping ? { x: ping.x, z: ping.z } : null,
          },
          {
            sprintTriggerRadius: BOT_SPRINT_TRIGGER_RADIUS,
            maxSprint: MAX_SPRINT,
            tagRadius: TAG_RADIUS_BOT,
            jumpEvadeBuffer: BOT_JUMP_EVADE_BUFFER,
          },
        );
        if (itemDecision.use) {
          this.host.useBotItem(bot);
          if (itemDecision.memorySeed) {
            mind.lastKnownPos = itemDecision.memorySeed;
            mind.investigateUntil = now + BOT_INVESTIGATE_MS;
          }
        }
      }

      if (wantJump) {
        bot.jumpStartedAt = now;
        mind.lastJumpedAt = now;
        // A banked Leap turns this takeoff into the boosted arc, mirroring the
        // human stepJump path. advanceIdleJumpState clears leaping on landing.
        if (bot.leapArmed) {
          bot.leaping = true;
          bot.leapArmed = false;
        }
      }

      let dir = { x: 0, z: 0 };
      if (decision.mode === 'flee' && target) {
        const away = wrappedUnitDelta(target.position, bot.position, topology, WORLD_WIDTH);
        // If this bot opened a portal, head into its own entry mouth instead of
        // the open-field flee point - that's the whole reason it spent the item.
        const portal = this.host.botPortalEntry(bot.id);
        const portalTarget = portal
          ? portalEscapeTarget(bot.position, away, portal.a, portal.b, topology, WORLD_WIDTH)
          : null;
        // Score escape directions instead of bolting straight away, so the bot
        // doesn't flee into a dead-end or toward a second enemy.
        const enemies: Vec2[] = [];
        for (const p of this.host.players.values()) {
          if (p.team !== bot.team && !p.frozen) enemies.push(p.position);
        }
        const fleeTarget =
          portalTarget ??
          bestFleeTarget(
            bot.position,
            target.position,
            enemies,
            walls,
            topology,
            WORLD_WIDTH,
            BOT_FLEE_PROJECTION,
          );
        const avoid = this.avoidPositionsForBot(bot);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, fleeTarget, avoid)
          : fleeTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'rescue' && rescueTarget) {
        const avoid = this.avoidPositionsForBot(bot);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, rescueTarget.position, avoid)
          : rescueTarget.position;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'chase' && target) {
        // Use the assigned flank slot only while still closing from range; once
        // inside FLANK_RELEASE_DIST drive straight at the target for the tag.
        const claim = chaseClaims.get(bot.id);
        const chaseGoal =
          claim && claim.targetId === target.id && enemyDist > BOT_CHASE_FLANK_RELEASE_DIST
            ? claim.goal
            : // Direct approach: intercept where the target is heading rather
              // than trailing its current spot.
              interceptPoint(
                bot.position,
                target.position,
                targetVel,
                SPRINT_SPEED,
                topology,
                WORLD_WIDTH,
              );
        const avoid = this.avoidPositionsForBot(bot);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, chaseGoal, avoid)
          : chaseGoal;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'investigate' && mind.lastKnownPos) {
        const avoid = this.avoidPositionsForBot(bot);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, mind.lastKnownPos, avoid)
          : mind.lastKnownPos;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'collect' && decision.collectTarget) {
        const avoid = this.avoidPositionsForBot(bot);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, decision.collectTarget, avoid)
          : decision.collectTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (fireThreat) {
        // Prey that can't see its hunter but sees its incoming fire: flee away
        // from the line of fire (same scorer as a seen-threat flee).
        const fleeTarget = bestFleeTarget(
          bot.position,
          fireThreat,
          [fireThreat],
          walls,
          topology,
          WORLD_WIDTH,
          BOT_FLEE_PROJECTION,
        );
        const avoid = this.avoidPositionsForBot(bot);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, fleeTarget, avoid)
          : fleeTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else {
        if (now >= mind.patrolUntil || nearTarget(bot.position, mind.patrolTarget)) {
          this.commitPatrolTarget(mind, bot, now);
          mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
        }
        const avoid = this.avoidPositionsForBot(bot);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, mind.patrolTarget, avoid)
          : mind.patrolTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      }
      dir = smoothDir(mind.lastDir, dir, DIR_SMOOTHING);
      mind.lastDir = dir;

      // Panic-sprint away when the incoming fire is close, mirroring the
      // close-threat sprint gate for a seen enemy.
      const fireClose =
        fireThreat !== null &&
        topologyDistance(bot.position, fireThreat, topology, WORLD_WIDTH) <
          BOT_SPRINT_TRIGGER_RADIUS;
      const closeEnemyOrRescue =
        (chasing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (fleeing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (rescuing && rescueDist < BOT_SPRINT_TRIGGER_RADIUS);
      const wantSprint = (closeEnemyOrRescue || fireClose) && bot.sprintEnergy > MAX_SPRINT * 0.15;
      const speed = wantSprint ? SPRINT_SPEED : WALK_SPEED;
      const step = speed * dt;
      const slid = stepWithSlide(bot.position, dir, step, walls, topology, WORLD_WIDTH);
      const moved = slid.moved;
      if (moved) {
        bot.position = { x: slid.x, y: bot.position.y, z: slid.z };
      }
      if (dir.x !== 0 || dir.z !== 0) {
        const desiredYaw = Math.atan2(-dir.x, -dir.z);
        mind.lastYaw = turnToward(mind.lastYaw, desiredYaw, MAX_YAW_RATE, dt);
        bot.yaw = mind.lastYaw;
      } else {
        mind.lastYaw = bot.yaw;
      }
      if (!moved) {
        const embedded =
          walls.length > 0 &&
          pathCrossesWall(walls, bot.position.x, bot.position.z, bot.position.x, bot.position.z);
        if (embedded) {
          // Recover toward the open center of the bot's own cell rather than
          // teleporting across the map to spawn (the old band-aid, which
          // yanked a bot mid-chase to the far side of the arena). Fall back to
          // spawn only if even the cell center sits inside a wall.
          const center = pathfinder ? pathfinder.cellCenterOf(bot.position) : null;
          if (center && !pathCrossesWall(walls, center.x, center.z, center.x, center.z)) {
            const wrapped = wrapPosition(center, topology, WORLD_WIDTH);
            bot.position = { x: wrapped.x, y: bot.position.y, z: wrapped.z };
          } else {
            bot.position = this.host.pickSpawnPosition(bot.team);
          }
        }
        this.commitPatrolTarget(mind, bot, now);
        mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
      }

      if (now - mind.progressSampleAt >= BOT_NO_PROGRESS_WINDOW_MS) {
        const covered = topologyDistance(
          mind.progressSamplePos,
          bot.position,
          topology,
          WORLD_WIDTH,
        );
        if (covered < BOT_NO_PROGRESS_MIN_DIST) {
          this.commitPatrolTarget(mind, bot, now);
          mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
          mind.engagedTargetId = null;
          mind.lastDir = { x: 0, z: 0 };
        }
        mind.progressSampleAt = now;
        mind.progressSamplePos = { x: bot.position.x, z: bot.position.z };
      }

      if (
        chasing &&
        target &&
        enemyDist <= TAG_RADIUS_BOT &&
        this.host.canTag(bot, target, TAG_RADIUS_BOT)
      ) {
        this.host.freezePlayer(target);
        this.host.broadcast({
          t: 'event',
          kind: { kind: 'tagged', attackerId: bot.id, victimId: target.id, team: bot.team },
        });
        this.host.checkWin();
      }

      if (canShoot && target) {
        // Lead the shot: aim where the target will be when the projectile
        // arrives, not where it is now.
        const aimPoint = interceptPoint(
          bot.position,
          target.position,
          targetVel,
          PROJECTILE_SPEED,
          topology,
          WORLD_WIDTH,
        );
        const aim = wrappedUnitDelta(bot.position, aimPoint, topology, WORLD_WIDTH);
        const jitter = (Math.random() - 0.5) * 2 * BOT_SHOOT_AIM_JITTER;
        const cos = Math.cos(jitter);
        const sin = Math.sin(jitter);
        this.host.botShoot(bot, {
          x: aim.x * cos - aim.z * sin,
          y: 0,
          z: aim.x * sin + aim.z * cos,
        });
      }

      if (
        rescuing &&
        rescueTarget &&
        rescueDist <= UNFREEZE_RADIUS_BOT &&
        (walls.length === 0 ||
          !pathCrossesWall(
            walls,
            bot.position.x,
            bot.position.z,
            rescueTarget.position.x,
            rescueTarget.position.z,
          ))
      ) {
        rescueTarget.frozen = false;
        this.host.lastSavedAt.set(rescueTarget.id, Date.now());
        this.host.broadcast({
          t: 'event',
          kind: { kind: 'saved', saviorId: bot.id, victimId: rescueTarget.id },
        });
      }

      bot.sprintEnergy = clamp(
        bot.sprintEnergy + (wantSprint && moved ? -SPRINT_DRAIN_PER_S : SPRINT_REGEN_PER_S) * dt,
        0,
        MAX_SPRINT,
      );
    }
  }

  private *botPlayers(): Generator<PlayerState> {
    for (const p of this.host.players.values()) {
      if (p.bot) yield p;
    }
  }
}
