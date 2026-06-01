import { describe, expect, it } from 'vitest';
import type { ItemType } from '@cm/shared';
import { decideItemUse, type ItemContext, type ItemParams } from './botItems.ts';

const PARAMS: ItemParams = {
  sprintTriggerRadius: 10,
  maxSprint: 100,
  tagRadius: 1.4,
  jumpEvadeBuffer: 0.5,
};

function ctx(over: Partial<ItemContext> = {}): ItemContext {
  return {
    chasing: false,
    fleeing: false,
    wantJump: false,
    canShoot: false,
    enemyDist: Infinity,
    sprintEnergy: 100,
    hasActionableEnemy: false,
    nearestEnemyPos: null,
    ...over,
  };
}

function use(item: ItemType | undefined, over: Partial<ItemContext> = {}) {
  return decideItemUse(item, ctx(over), PARAMS);
}

describe('decideItemUse per-item policies', () => {
  it('holds when there is no item', () => {
    expect(use(undefined)).toEqual({ use: false, memorySeed: null });
  });

  it('spends leap only on the jump it is taking', () => {
    expect(use('leap', { wantJump: true }).use).toBe(true);
    expect(use('leap', { wantJump: false }).use).toBe(false);
  });

  it('spends surge when engaged, close, and low on energy', () => {
    expect(use('surge', { chasing: true, enemyDist: 5, sprintEnergy: 40 }).use).toBe(true);
    // Full energy: no need.
    expect(use('surge', { chasing: true, enemyDist: 5, sprintEnergy: 90 }).use).toBe(false);
    // Too far.
    expect(use('surge', { fleeing: true, enemyDist: 15, sprintEnergy: 10 }).use).toBe(false);
    // Not engaged.
    expect(use('surge', { enemyDist: 5, sprintEnergy: 10 }).use).toBe(false);
  });

  it('spends overcharge only when a shot is lined up', () => {
    expect(use('overcharge', { canShoot: true }).use).toBe(true);
    expect(use('overcharge', { canShoot: false }).use).toBe(false);
  });

  it('spends cloak when fleeing a close pursuer', () => {
    expect(use('cloak', { fleeing: true, enemyDist: 8 }).use).toBe(true);
    expect(use('cloak', { fleeing: true, enemyDist: 12 }).use).toBe(false);
    expect(use('cloak', { chasing: true, enemyDist: 8 }).use).toBe(false);
  });

  it('spends clone whenever actively engaged', () => {
    expect(use('clone', { chasing: true }).use).toBe(true);
    expect(use('clone', { fleeing: true }).use).toBe(true);
    expect(use('clone').use).toBe(false);
  });

  it('spends portal as a last-ditch escape when a tagger is on top of it', () => {
    // tagRadius 1.4 + 2 * jumpEvadeBuffer 0.5 = 2.4
    expect(use('portal', { fleeing: true, enemyDist: 2 }).use).toBe(true);
    expect(use('portal', { fleeing: true, enemyDist: 3 }).use).toBe(false);
    expect(use('portal', { chasing: true, enemyDist: 2 }).use).toBe(false);
  });
});

describe('decideItemUse radar holds vs. relocates', () => {
  it('holds radar while it has an actionable enemy in sight', () => {
    const d = use('radar', { hasActionableEnemy: true, nearestEnemyPos: { x: 5, z: 0 } });
    expect(d.use).toBe(false);
    expect(d.memorySeed).toBeNull();
  });

  it('holds radar when no enemy exists to relocate', () => {
    const d = use('radar', { hasActionableEnemy: false, nearestEnemyPos: null });
    expect(d.use).toBe(false);
  });

  it('spends radar to seed memory toward an enemy it cannot act on', () => {
    const d = use('radar', { hasActionableEnemy: false, nearestEnemyPos: { x: 40, z: -3 } });
    expect(d.use).toBe(true);
    expect(d.memorySeed).toEqual({ x: 40, z: -3 });
  });
});
