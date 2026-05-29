// Bot AI extracted from room.ts under Phase B1 of the file-split plan.
// Owns the BotMind state map + the bot fill / simulation loop +
// patrol/exploration helpers. Hosts via a BotManagerHost interface so
// Room (and tests) can supply the surrounding state without exposing
// the whole DurableObject.
//
// Behavior preserved verbatim from the original room.ts methods; the
// Phase A1 simulate fixture regression-tests the human side, and new
// tests in this file cover the bot-specific paths.

import type { PlayerState, ServerToClient, Team, Topology, Vec2, Vec3 } from '@cm/shared';
import { topologyDistance, wrapPosition, wrappedUnitDelta } from '@cm/shared/topology';
import { pathCrossesWall, pointBlockedByWall, type WallSegment } from '@cm/shared/labyrinth';
import {
  MAX_SPRINT,
  SPRINT_DRAIN_PER_S,
  SPRINT_REGEN_PER_S,
  SPRINT_SPEED,
  WALK_SPEED,
} from '@cm/shared/movement';
import type { BotPathfinder } from './botPathfinder.ts';

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
}

const BOT_NAME_ADJECTIVES = [
  'Silent',
  'Painted',
  'Loud',
  'Floppy',
  'Crooked',
  'Bashful',
  'Velvet',
  'Hushed',
  'Ruffled',
  'Striped',
  'Glossy',
  'Pale',
  'Sneaky',
  'Whiskered',
  'Brittle',
  'Tipsy',
  'Polka',
  'Wobbly',
  'Crinkled',
  'Powdered',
  'Squeaky',
  'Tufted',
  'Knobbly',
  'Frilly',
  'Wonky',
  'Boggled',
  'Plucky',
  'Drooping',
];

const BOT_NAME_NOUNS = [
  'Bozo',
  'Coulrophobe',
  'Pierrot',
  'Harlequin',
  'Buffoon',
  'Jester',
  'Marceau',
  'Tramp',
  'Auguste',
  'Whiteface',
  'Carnie',
  'Pagliacci',
  'Punchinello',
  'Hopo',
  'Cake',
  'Honk',
  'Greasepaint',
  'Stripes',
  'Tear',
  'Glove',
  'Wig',
  'Nose',
  'Shoe',
  'Banana',
  'Pinwheel',
  'Smile',
  'Frown',
  'Lapel',
];

function generateBotName(): string {
  const adj = BOT_NAME_ADJECTIVES[Math.floor(Math.random() * BOT_NAME_ADJECTIVES.length)]!;
  const noun = BOT_NAME_NOUNS[Math.floor(Math.random() * BOT_NAME_NOUNS.length)]!;
  const num = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return `${adj}${noun}${num}`;
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
          name: generateBotName(),
          team,
          bot: true,
          position: spawn,
          yaw: 0,
          frozen: false,
          sprintEnergy: MAX_SPRINT,
          sprinting: false,
          jumpStartedAt: null,
        });
        this.botMinds.set(id, {
          patrolTarget: this.randomPatrolPoint(),
          patrolUntil: 0,
          engagedTargetId: null,
          lastDir: { x: 0, z: 0 },
          lastYaw: 0,
          progressSampleAt: Date.now(),
          progressSamplePos: { x: spawn.x, z: spawn.z },
          lastKnownPos: null,
          investigateUntil: 0,
          recentTargets: [],
          lastJumpedAt: 0,
        });
      }
    }
    this.host.notifyMatchmaker(this.host.humanCount(), this.host.botCount());
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

  private nearestVisibleEnemy(bot: PlayerState): PlayerState | null {
    let best: PlayerState | null = null;
    let bestDist = Infinity;
    const topology = this.host.getTopology();
    for (const other of this.host.players.values()) {
      if (other.id === bot.id) continue;
      if (other.team === bot.team) continue;
      if (other.frozen) continue;
      if (!this.botCanSee(bot.position, other.position)) continue;
      const d = topologyDistance(bot.position, other.position, topology, WORLD_WIDTH);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
  }

  private botCanSee(from: Vec2, to: Vec2): boolean {
    const walls = this.host.getWalls();
    if (walls.length === 0) return true;
    return !pathCrossesWall(walls, from.x, from.z, to.x, to.z);
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
    const topology = this.host.getTopology();
    const walls = this.host.getWalls();
    const pathfinder = this.host.getPathfinder();
    const DIR_SMOOTHING = 0.5;
    const MAX_YAW_RATE = 9.0;
    const RETARGET_HYSTERESIS = 0.75;

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
      };
      this.botMinds.set(bot.id, mind);

      const candidate = this.nearestVisibleEnemy(bot);
      const candidateDist = candidate
        ? topologyDistance(bot.position, candidate.position, topology, WORLD_WIDTH)
        : Infinity;
      let target: PlayerState | null = candidate;
      let enemyDist = candidateDist;
      if (mind.engagedTargetId) {
        const existing = this.host.players.get(mind.engagedTargetId);
        if (existing && !existing.frozen && existing.team !== bot.team) {
          const existingVisible = this.botCanSee(bot.position, existing.position);
          const existingDist = topologyDistance(
            bot.position,
            existing.position,
            topology,
            WORLD_WIDTH,
          );
          if (
            existingVisible &&
            existingDist < BOT_VISION_RADIUS &&
            candidateDist >= existingDist * RETARGET_HYSTERESIS
          ) {
            target = existing;
            enemyDist = existingDist;
          } else if (!existingVisible && existingDist < BOT_VISION_RADIUS) {
            if (active === bot.team) {
              if (!mind.lastKnownPos) {
                mind.lastKnownPos = { x: existing.position.x, z: existing.position.z };
                mind.investigateUntil = now + BOT_INVESTIGATE_MS;
              }
            } else {
              mind.engagedTargetId = null;
              mind.lastKnownPos = null;
              mind.investigateUntil = 0;
            }
          }
        } else {
          mind.engagedTargetId = null;
          mind.lastKnownPos = null;
          mind.investigateUntil = 0;
        }
      }
      if (target) {
        mind.engagedTargetId = target.id;
        mind.lastKnownPos = { x: target.position.x, z: target.position.z };
        mind.investigateUntil = 0;
      } else if (mind.investigateUntil > 0 && now >= mind.investigateUntil) {
        mind.engagedTargetId = null;
        mind.lastKnownPos = null;
        mind.investigateUntil = 0;
      }
      const investigating =
        target === null && mind.lastKnownPos !== null && now < mind.investigateUntil;

      let rescueTarget: PlayerState | null = null;
      let rescueDist = Infinity;
      for (const other of this.host.players.values()) {
        if (other.id === bot.id) continue;
        if (other.team !== bot.team) continue;
        if (!other.frozen) continue;
        const d = topologyDistance(bot.position, other.position, topology, WORLD_WIDTH);
        if (d < BOT_VISION_RADIUS && d < rescueDist) {
          rescueDist = d;
          rescueTarget = other;
        }
      }

      const chasing = target !== null && enemyDist < BOT_VISION_RADIUS && active === bot.team;
      const fleeing =
        target !== null && enemyDist < BOT_VISION_RADIUS && active && active !== bot.team;
      const rescuing = rescueTarget !== null;

      const sinceLastJump = now - mind.lastJumpedAt;
      const jumpEligible = bot.jumpStartedAt === null && sinceLastJump >= BOT_JUMP_REFRACTORY_MS;
      let wantJump = false;
      if (jumpEligible) {
        if (
          fleeing &&
          target !== null &&
          !target.frozen &&
          target.jumpStartedAt === null &&
          enemyDist <= TAG_RADIUS_BOT + BOT_JUMP_EVADE_BUFFER
        ) {
          wantJump = true;
        }
        if (!wantJump) {
          const noProgressDur = now - mind.progressSampleAt;
          if (
            noProgressDur >= BOT_NO_PROGRESS_WINDOW_MS &&
            enemyDist <= BOT_JUMP_CORNER_THREAT_RADIUS
          ) {
            wantJump = true;
          }
        }
        if (!wantJump && chasing) {
          if (Math.random() < BOT_JUMP_NOISE_PER_SECOND * dt) {
            wantJump = true;
          }
        }
      }
      if (wantJump) {
        bot.jumpStartedAt = now;
        mind.lastJumpedAt = now;
      }

      let dir = { x: 0, z: 0 };
      if (fleeing && target) {
        const away = wrappedUnitDelta(target.position, bot.position, topology, WORLD_WIDTH);
        const fleeTarget = wrapPosition(
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
      } else if (rescuing && rescueTarget) {
        const avoid = this.avoidCellsForBot(bot, rescueTarget);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, rescueTarget.position, avoid)
          : rescueTarget.position;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (chasing && target) {
        const avoid = this.avoidCellsForBot(bot, target);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, target.position, avoid)
          : target.position;
        dir = wrappedUnitDelta(bot.position, waypoint, topology, WORLD_WIDTH);
      } else if (investigating && mind.lastKnownPos) {
        const avoid = this.avoidCellsForBot(bot, null);
        const waypoint = pathfinder
          ? pathfinder.nextWaypointAvoiding(bot.position, mind.lastKnownPos, avoid)
          : mind.lastKnownPos;
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
      dir = {
        x: mind.lastDir.x * DIR_SMOOTHING + dir.x * (1 - DIR_SMOOTHING),
        z: mind.lastDir.z * DIR_SMOOTHING + dir.z * (1 - DIR_SMOOTHING),
      };
      const dirLen = Math.hypot(dir.x, dir.z);
      if (dirLen > 1e-3) {
        dir = { x: dir.x / dirLen, z: dir.z / dirLen };
      } else {
        dir = { x: 0, z: 0 };
      }
      mind.lastDir = dir;

      const closeEnemyOrRescue =
        (chasing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (fleeing && enemyDist < BOT_SPRINT_TRIGGER_RADIUS) ||
        (rescuing && rescueDist < BOT_SPRINT_TRIGGER_RADIUS);
      const wantSprint = closeEnemyOrRescue && bot.sprintEnergy > MAX_SPRINT * 0.15;
      const speed = wantSprint ? SPRINT_SPEED : WALK_SPEED;
      const step = speed * dt;
      const candidates: Array<{ x: number; z: number; chosen: { x: number; z: number } }> = [
        {
          x: bot.position.x + dir.x * step,
          z: bot.position.z + dir.z * step,
          chosen: dir,
        },
        {
          x: bot.position.x + Math.sign(dir.x) * step,
          z: bot.position.z,
          chosen: { x: Math.sign(dir.x), z: 0 },
        },
        {
          x: bot.position.x,
          z: bot.position.z + Math.sign(dir.z) * step,
          chosen: { x: 0, z: Math.sign(dir.z) },
        },
      ];
      let moved = false;
      for (const c of candidates) {
        if (c.chosen.x === 0 && c.chosen.z === 0) continue;
        const wallBlocked =
          walls.length > 0 && pathCrossesWall(walls, bot.position.x, bot.position.z, c.x, c.z);
        if (wallBlocked) continue;
        const wrapped = wrapPosition({ x: c.x, z: c.z }, topology, WORLD_WIDTH);
        bot.position = { x: wrapped.x, y: bot.position.y, z: wrapped.z };
        moved = true;
        break;
      }
      if (dir.x !== 0 || dir.z !== 0) {
        const desiredYaw = Math.atan2(-dir.x, -dir.z);
        let yawDelta = desiredYaw - mind.lastYaw;
        while (yawDelta > Math.PI) yawDelta -= 2 * Math.PI;
        while (yawDelta < -Math.PI) yawDelta += 2 * Math.PI;
        const maxStep = MAX_YAW_RATE * dt;
        const clamped = Math.max(-maxStep, Math.min(maxStep, yawDelta));
        mind.lastYaw += clamped;
        bot.yaw = mind.lastYaw;
      } else {
        mind.lastYaw = bot.yaw;
      }
      if (!moved) {
        if (
          walls.length > 0 &&
          pathCrossesWall(walls, bot.position.x, bot.position.z, bot.position.x, bot.position.z)
        ) {
          bot.position = this.host.pickSpawnPosition(bot.team);
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
