// Item-value layer for the bot AI, extracted from botManager.botShouldUseItem.
//
// Decides whether the bot fires its single held power-up this tick. Each type
// is only worth spending when its effect serves the bot's current intent, so
// this is a per-item policy rather than a "use the moment you have one" reflex
// - holding a power-up in reserve is a valid (and often better) choice.
//
// Radar is the one type whose value isn't a body effect: it reveals the enemy
// team. For an AI that already perceives nearby players directly that reveal is
// dead weight, so instead of dumping radar to clear the slot, the bot holds it
// until it has lost track of every actionable enemy, then spends it to relocate
// the nearest one - the decision returns a `memorySeed` the caller writes into
// the bot's investigate memory so it heads toward that ping next tick.

import type { ItemType } from '@cm/shared';

export interface ItemContext {
  chasing: boolean;
  fleeing: boolean;
  wantJump: boolean;
  canShoot: boolean;
  enemyDist: number;
  sprintEnergy: number;
  // True when the bot has an actionable enemy in vision this tick. Radar is
  // only worth spending when this is false (nothing to act on directly).
  hasActionableEnemy: boolean;
  // Nearest enemy anywhere on the field (radar's view, ignoring walls/cloak/
  // range), or null when none exists. Radar pings this position.
  nearestEnemyPos: { x: number; z: number } | null;
}

export interface ItemParams {
  sprintTriggerRadius: number;
  maxSprint: number;
  tagRadius: number;
  jumpEvadeBuffer: number;
}

export interface ItemDecision {
  use: boolean;
  // Set only when spending radar: the position to seed the bot's investigate
  // memory with so it heads toward an enemy it can't currently perceive. null
  // for every other item and for radar held in reserve.
  memorySeed: { x: number; z: number } | null;
}

const HOLD: ItemDecision = { use: false, memorySeed: null };
const SPEND: ItemDecision = { use: true, memorySeed: null };

/**
 * Decide whether to use the bot's held `item` this tick given what it senses.
 * Pure: returns the decision; the caller applies the effect and writes any
 * `memorySeed`. Returns HOLD when there is no item or its effect wouldn't help.
 */
export function decideItemUse(
  item: ItemType | undefined,
  ctx: ItemContext,
  params: ItemParams,
): ItemDecision {
  switch (item) {
    case 'radar':
      // Spend only when blind to every actionable enemy but one exists to
      // relocate; otherwise hold it rather than waste the reveal.
      if (!ctx.hasActionableEnemy && ctx.nearestEnemyPos) {
        return { use: true, memorySeed: ctx.nearestEnemyPos };
      }
      return HOLD;
    case 'leap':
      // Boost the jump the bot is already taking this tick.
      return ctx.wantJump ? SPEND : HOLD;
    case 'surge':
      // Sprint boost when engaged at close range and running low on energy.
      return (ctx.chasing || ctx.fleeing) &&
        ctx.enemyDist < params.sprintTriggerRadius &&
        ctx.sprintEnergy < params.maxSprint * 0.5
        ? SPEND
        : HOLD;
    case 'overcharge':
      // Arm the shot the bot is about to fire.
      return ctx.canShoot ? SPEND : HOLD;
    case 'cloak':
      // Break contact while fleeing a close pursuer.
      return ctx.fleeing && ctx.enemyDist <= params.sprintTriggerRadius ? SPEND : HOLD;
    case 'clone':
      // A decoy is useful whenever the bot is actively engaged either way.
      return ctx.chasing || ctx.fleeing ? SPEND : HOLD;
    case 'portal':
      // Last-ditch escape when a tagger is right on top of the bot.
      return ctx.fleeing && ctx.enemyDist <= params.tagRadius + params.jumpEvadeBuffer * 2
        ? SPEND
        : HOLD;
    default:
      return HOLD;
  }
}
