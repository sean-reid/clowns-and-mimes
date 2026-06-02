// Bot AI extracted from room.ts under Phase B1 of the file-split plan.
// Owns the BotMind state map + the bot fill / simulation loop +
// patrol/exploration helpers. Hosts via a BotManagerHost interface so
// Room (and tests) can supply the surrounding state without exposing
// the whole DurableObject.
//
// Behavior preserved verbatim from the original room.ts methods; the
// Phase A1 simulate fixture regression-tests the human side, and new
// tests in this file cover the bot-specific paths.

import type { ItemType, PlayerState, ServerToClient, Team, Topology, Vec3 } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedUnitDelta } from '@cm/shared/topology';
import { pathCrossesWall, pointBlockedByWall, type WallSegment } from '@cm/shared/labyrinth';
import { generateRandomName } from '@cm/shared/names';
import {
  MAX_SPRINT,
  SPRINT_DRAIN_PER_S,
  SPRINT_REGEN_PER_S,
  SPRINT_SPEED,
  WALK_SPEED,
} from '@cm/shared/movement';
import type { BotPathfinder } from './botPathfinder.ts';
import { smoothDir, stepWithSlide, turnToward } from './botSteering.ts';
import { decideBotAction } from './botDecision.ts';
import { decideItemUse } from './botItems.ts';
import { nearestEnemy } from './botPerception.ts';
import { nearestItemTarget, portalEscapeTarget } from './botGoals.ts';
import { assignRescues } from './botCoordination.ts';

// World half-extent (kept private here; Room owns the canonical constant).
const WORLD_WIDTH = 80;

// Bot AI constants. All bot tuning lives here so a single read explains
// the AI's behavior.
const TEAM_TARGET = 4;
const BOT_FILL_DELAY_MS = 3_000;
const TAG_RADIUS_BOT = 1.4;
const UNFREEZE_RADIUS_BOT = 1.4;
const BOT_VISION_RADIUS = 22;
const BOT_PATROL_RETARGET_MS = 4_000;
const BOT_SPRINT_TRIGGER_RADIUS = 10;
// A bot holding no item will detour to grab a floor item within this range.
// Inside vision (22) so it only chases items it can plausibly reach.
const BOT_ITEM_SEEK_RADIUS = 16;
const BOT_NO_PROGRESS_WINDOW_MS = 800;
const BOT_NO_PROGRESS_MIN_DIST = 0.5;
const BOT_FLEE_PROJECTION = 12;
const BOT_INVESTIGATE_MS = 3_000;
const BOT_RECENT_TARGETS_KEEP = 6;
const BOT_RECENT_TARGET_RADIUS = 10;
const BOT_PATROL_CANDIDATE_ATTEMPTS = 8;
const BOT_JUMP_REFRACTORY_MS = 1500;
const BOT_JUMP_NOISE_PER_SECOND = 0.05;
const BOT_JUMP_EVADE_BUFFER = 0.5;
const BOT_JUMP_CORNER_THREAT_RADIUS = 4.0;
// Bots fire at a visible enemy within this range during their turn. Inside
// BOT_VISION_RADIUS but tighter, so shots have a realistic chance to connect
// before the projectile expires.
const BOT_SHOOT_RANGE = 18;
// Random angular spread (radians) added to each bot shot so aim isn't pixel
// perfect; keeps bots beatable and shots from feeling robotic.
const BOT_SHOOT_AIM_JITTER = 0.09;
// Clone power-up: a temporary ally bot lives this long, then despawns.
const CLONE_DURATION_MS = 30_000;
// Clone spawns this far from its owner, on the first unobstructed bearing.
const CLONE_SPAWN_OFFSET = 2.0;

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
  recentTargets: Array<{ x: number; z: number }>;
  lastJumpedAt: number;
  // Fixed per-bot jitter in [0,1) that staggers the deterministic jump
  // triggers, so two bots in the same situation don't take off on the exact
  // same tick (the reactive evade / no-progress jumps would otherwise fire
  // simultaneously across a cluster).
  jumpPhase: number;
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
      recentTargets: [],
      lastJumpedAt: 0,
      jumpPhase: Math.random(),
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
    const half = WORLD_WIDTH / 2;
    return {
      x: (Math.random() - 0.5) * 2 * (half - 4),
      z: (Math.random() - 0.5) * 2 * (half - 4),
    };
  }

  private pickExplorationPatrolPoint(recentTargets: ReadonlyArray<{ x: number; z: number }>): {
    x: number;
    z: number;
  } {
    let last = this.randomPatrolPoint();
    const walls = this.host.getWalls();
    for (let attempt = 0; attempt < BOT_PATROL_CANDIDATE_ATTEMPTS; attempt += 1) {
      const candidate = this.randomPatrolPoint();
      last = candidate;
      if (walls.length > 0 && pointBlockedByWall(walls, candidate.x, candidate.z)) {
        continue;
      }
      let tooClose = false;
      for (const recent of recentTargets) {
        const dx = candidate.x - recent.x;
        const dz = candidate.z - recent.z;
        if (dx * dx + dz * dz < BOT_RECENT_TARGET_RADIUS * BOT_RECENT_TARGET_RADIUS) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      return candidate;
    }
    return last;
  }

  private commitPatrolTarget(mind: BotMind): void {
    mind.patrolTarget = this.pickExplorationPatrolPoint(mind.recentTargets);
    mind.recentTargets.push({ x: mind.patrolTarget.x, z: mind.patrolTarget.z });
    while (mind.recentTargets.length > BOT_RECENT_TARGETS_KEEP) {
      mind.recentTargets.shift();
    }
  }

  private avoidCellsForBot(self: PlayerState, preserve: PlayerState | null): Set<number> {
    const out = new Set<number>();
    const pathfinder = this.host.getPathfinder();
    if (!pathfinder) return out;
    const preserveId = preserve ? preserve.id : null;
    for (const other of this.host.players.values()) {
      if (other.id === self.id) continue;
      if (other.id === preserveId) continue;
      out.add(pathfinder.cellAt(other.position));
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
    const DIR_SMOOTHING = 0.5;
    const MAX_YAW_RATE = 9.0;
    const RETARGET_HYSTERESIS = 0.75;
    // One rescue claim per frozen teammate, so bots spread across distinct
    // allies instead of swarming the nearest one. Computed once per tick.
    const rescueClaims = assignRescues(
      this.host.players.values(),
      topology,
      WORLD_WIDTH,
      BOT_VISION_RADIUS,
    );

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
        recentTargets: [],
        lastJumpedAt: 0,
        jumpPhase: Math.random(),
      };
      this.botMinds.set(bot.id, mind);

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

      const sinceLastJump = now - mind.lastJumpedAt;
      const jumpEligible = bot.jumpStartedAt === null && sinceLastJump >= BOT_JUMP_REFRACTORY_MS;
      let wantJump = false;
      if (jumpEligible) {
        // Per-bot jitter so a cluster reacting to the same threat doesn't take
        // off on one tick: the evade range and the no-progress window each vary
        // a little per bot (jumpPhase in [0,1)).
        const evadeBuffer = BOT_JUMP_EVADE_BUFFER * (0.5 + mind.jumpPhase);
        const noProgressWindow = BOT_NO_PROGRESS_WINDOW_MS * (0.75 + 0.5 * mind.jumpPhase);
        if (
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
        const fleeTarget =
          portalTarget ??
          wrapPosition(
            {
              x: bot.position.x + away.x * BOT_FLEE_PROJECTION,
              z: bot.position.z + away.z * BOT_FLEE_PROJECTION,
            },
            topology,
            WORLD_WIDTH,
          );
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, fleeTarget, avoid)
          : fleeTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'rescue' && rescueTarget) {
        const avoid = this.avoidCellsForBot(bot, rescueTarget);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, rescueTarget.position, avoid)
          : rescueTarget.position;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'chase' && target) {
        const avoid = this.avoidCellsForBot(bot, target);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, target.position, avoid)
          : target.position;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'investigate' && mind.lastKnownPos) {
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, mind.lastKnownPos, avoid)
          : mind.lastKnownPos;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (decision.mode === 'collect' && decision.collectTarget) {
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, decision.collectTarget, avoid)
          : decision.collectTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else {
        if (now >= mind.patrolUntil || nearTarget(bot.position, mind.patrolTarget)) {
          this.commitPatrolTarget(mind);
          mind.patrolUntil = now + BOT_PATROL_RETARGET_MS;
        }
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, mind.patrolTarget, avoid)
          : mind.patrolTarget;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      }
      dir = smoothDir(mind.lastDir, dir, DIR_SMOOTHING);
      mind.lastDir = dir;

      const closeEnemyOrRescue =
        (chasing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (fleeing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (rescuing && rescueDist < BOT_SPRINT_TRIGGER_RADIUS);
      const wantSprint = closeEnemyOrRescue && bot.sprintEnergy > MAX_SPRINT * 0.15;
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
        this.commitPatrolTarget(mind);
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
          this.commitPatrolTarget(mind);
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
        const aim = wrappedUnitDelta(bot.position, target.position, topology, WORLD_WIDTH);
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
