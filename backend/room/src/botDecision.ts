// Decision layer for the bot AI, extracted from botManager.simulate.
//
// Turns "what the bot senses" into "what the bot intends": it resolves which
// enemy the bot is engaged with (with retarget hysteresis and an
// investigate-last-known-position grace), derives the action flags the rest
// of the tick reads (chase / flee / rescue / shoot), and picks a single
// movement mode by scoring the candidates.
//
// The movement scores currently encode the original fixed priority
// (flee > rescue > chase > investigate > patrol) so behavior is preserved,
// but expressing it as a scored selection is the seam later phases extend:
// item use and team coordination add candidates into the same comparison
// rather than bolting on another branch.
//
// Engagement is stateful (it carries across ticks), so decideBotAction
// mutates the passed Engagement in place - the same object the caller stores
// on the bot's mind. Everything else it reads is a pure snapshot.

import type { PlayerState, Team, Topology, Vec2 } from '@cm/shared';
import { topologyDistance } from '@cm/shared/topology';
import type { WallSegment } from '@cm/shared/labyrinth';
import { bestVisibleEnemy, botCanSee, isCloaked, nearestFrozenAlly } from './botPerception.ts';

export type MovementMode = 'flee' | 'rescue' | 'chase' | 'investigate' | 'collect' | 'patrol';

// The slice of a bot's mind this layer owns and mutates across ticks.
export interface Engagement {
  engagedTargetId: string | null;
  lastKnownPos: { x: number; z: number } | null;
  investigateUntil: number;
}

export interface DecisionParams {
  visionRadius: number;
  shootRange: number;
  retargetHysteresis: number;
  investigateMs: number;
}

export interface BotDecision {
  mode: MovementMode;
  // Engaged enemy for chase/flee (null when patrolling/rescuing only).
  target: PlayerState | null;
  enemyDist: number;
  rescueTarget: PlayerState | null;
  rescueDist: number;
  // Floor item to walk onto when mode is 'collect' (echoed back from the
  // caller-supplied candidate), else null.
  collectTarget: Vec2 | null;
  // Independent action flags. They can overlap (a bot can flee for movement
  // yet still be close enough to rescue a frozen ally), so the caller reads
  // them separately from `mode`.
  chasing: boolean;
  fleeing: boolean;
  rescuing: boolean;
  investigating: boolean;
  canShoot: boolean;
}

/**
 * Resolve the bot's engaged target (mutating `engagement`) and return the
 * action flags + chosen movement mode. `activeTurnTeam` is the team whose
 * turn it is (null between turns); a bot chases on its own turn and flees on
 * the enemy's.
 */
export function decideBotAction(
  bot: PlayerState,
  players: Iterable<PlayerState>,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  now: number,
  activeTurnTeam: Team | null,
  engagement: Engagement,
  params: DecisionParams,
  collectTarget: Vec2 | null = null,
  // Team-coordinated rescue assignment. When omitted, the bot falls back to its
  // own nearest frozen ally; pass null to suppress rescue, or a claim to force
  // a specific ally (so two bots don't swarm one). See botCoordination.
  rescueOverride?: { target: PlayerState; dist: number } | null,
): BotDecision {
  const roster = [...players];
  const candidate = bestVisibleEnemy(bot, roster, walls, topology, worldWidth, now);
  const candidateDist = candidate
    ? topologyDistance(bot.position, candidate.position, topology, worldWidth)
    : Infinity;

  let target: PlayerState | null = candidate;
  let enemyDist = candidateDist;

  if (engagement.engagedTargetId) {
    const existing = roster.find((p) => p.id === engagement.engagedTargetId) ?? null;
    // A target that activates Cloak vanishes from perception entirely:
    // engagement is dropped outright (the else), with none of the
    // investigate-last-known reaction a wall occlusion would trigger.
    if (existing && !existing.frozen && existing.team !== bot.team && !isCloaked(existing, now)) {
      const existingVisible = botCanSee(walls, bot.position, existing.position);
      const existingDist = topologyDistance(bot.position, existing.position, topology, worldWidth);
      if (
        existingVisible &&
        existingDist < params.visionRadius &&
        candidateDist >= existingDist * params.retargetHysteresis
      ) {
        // Stay locked on the current target unless a new one is meaningfully
        // closer (hysteresis), to avoid flip-flopping between two enemies.
        target = existing;
        enemyDist = existingDist;
      } else if (!existingVisible && existingDist < params.visionRadius) {
        if (activeTurnTeam === bot.team) {
          // On our turn, remember where they were and go look there.
          if (!engagement.lastKnownPos) {
            engagement.lastKnownPos = { x: existing.position.x, z: existing.position.z };
            engagement.investigateUntil = now + params.investigateMs;
          }
        } else {
          // On the enemy's turn there's nothing to gain from hunting; drop it.
          clearEngagement(engagement);
        }
      }
    } else {
      clearEngagement(engagement);
    }
  }

  if (target) {
    engagement.engagedTargetId = target.id;
    engagement.lastKnownPos = { x: target.position.x, z: target.position.z };
    engagement.investigateUntil = 0;
  } else if (engagement.investigateUntil > 0 && now >= engagement.investigateUntil) {
    clearEngagement(engagement);
  }

  const investigating =
    target === null && engagement.lastKnownPos !== null && now < engagement.investigateUntil;

  const rescue: { target: PlayerState | null; dist: number } =
    rescueOverride === undefined
      ? nearestFrozenAlly(bot, roster, topology, worldWidth, params.visionRadius)
      : (rescueOverride ?? { target: null, dist: Infinity });

  const enemyInRange = target !== null && enemyDist < params.visionRadius;
  const chasing = enemyInRange && activeTurnTeam === bot.team;
  const fleeing = enemyInRange && activeTurnTeam !== null && activeTurnTeam !== bot.team;
  const rescuing = rescue.target !== null;
  // Fire only on our own turn, at a visible enemy in range. botShoot
  // re-validates phase + cooldown, so this is the AI gate, not the rule.
  const canShoot =
    chasing &&
    target !== null &&
    enemyDist <= params.shootRange &&
    botCanSee(walls, bot.position, target.position);

  // Only collect while not engaged: a held item blocks pickup, so the caller
  // passes null when the bot already holds one; here it stays a candidate that
  // simply loses to any combat/rescue/investigate goal in the scoring.
  const collecting = collectTarget !== null;

  return {
    mode: chooseMovementMode({ fleeing, rescuing, chasing, investigating, collecting }),
    target,
    enemyDist,
    rescueTarget: rescue.target,
    rescueDist: rescue.dist,
    collectTarget,
    chasing,
    fleeing,
    rescuing,
    investigating,
    canShoot,
  };
}

function clearEngagement(e: Engagement): void {
  e.engagedTargetId = null;
  e.lastKnownPos = null;
  e.investigateUntil = 0;
}

// Score each available movement mode and take the best. The constants encode
// the original priority (flee beats rescue beats chase beats investigate
// beats the always-available patrol); later phases adjust these or add
// candidates (e.g. break off to grab an item) into the same argmax.
function chooseMovementMode(flags: {
  fleeing: boolean;
  rescuing: boolean;
  chasing: boolean;
  investigating: boolean;
  collecting: boolean;
}): MovementMode {
  const scores: Array<{ mode: MovementMode; score: number }> = [
    { mode: 'flee', score: flags.fleeing ? 100 : -Infinity },
    { mode: 'rescue', score: flags.rescuing ? 80 : -Infinity },
    { mode: 'chase', score: flags.chasing ? 60 : -Infinity },
    { mode: 'investigate', score: flags.investigating ? 40 : -Infinity },
    // Grabbing an item is opportunistic: it beats aimless patrol but yields to
    // any combat, rescue, or investigate goal.
    { mode: 'collect', score: flags.collecting ? 20 : -Infinity },
    { mode: 'patrol', score: 1 },
  ];
  let best = scores[0]!;
  for (const s of scores) {
    if (s.score > best.score) best = s;
  }
  return best.mode;
}
