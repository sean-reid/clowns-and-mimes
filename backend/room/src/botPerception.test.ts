import { describe, expect, it } from 'vitest';
import type { PlayerState } from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import { botCanSee, isCloaked, nearestFrozenAlly, nearestVisibleEnemy } from './botPerception.ts';

function player(over: Partial<PlayerState> & Pick<PlayerState, 'id' | 'team'>): PlayerState {
  return {
    name: over.id,
    bot: false,
    position: { x: 0, y: 0.5, z: 0 },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
    ...over,
  } as PlayerState;
}

describe('isCloaked', () => {
  it('is true only while cloakUntil is in the future', () => {
    expect(isCloaked(player({ id: 'a', team: 'mime', cloakUntil: 100 }), 50)).toBe(true);
    expect(isCloaked(player({ id: 'a', team: 'mime', cloakUntil: 100 }), 150)).toBe(false);
    expect(isCloaked(player({ id: 'a', team: 'mime' }), 50)).toBe(false);
  });
});

describe('botCanSee', () => {
  it('sees everything when there are no walls', () => {
    expect(botCanSee([], { x: 0, z: 0 }, { x: 10, z: 10 })).toBe(true);
  });

  it('is blocked by a wall between the two points', () => {
    const walls: WallSegment[] = [{ ax: 5, az: -5, bx: 5, bz: 5 }];
    expect(botCanSee(walls, { x: 0, z: 0 }, { x: 10, z: 0 })).toBe(false);
    expect(botCanSee(walls, { x: 0, z: 0 }, { x: 4, z: 0 })).toBe(true);
  });
});

describe('nearestVisibleEnemy', () => {
  const bot = player({ id: 'bot', team: 'mime', position: { x: 0, y: 0.5, z: 0 } });

  it('picks the nearest enemy with line of sight', () => {
    const near = player({ id: 'near', team: 'clown', position: { x: 3, y: 0.5, z: 0 } });
    const far = player({ id: 'far', team: 'clown', position: { x: 9, y: 0.5, z: 0 } });
    const got = nearestVisibleEnemy(bot, [bot, far, near], [], 'plane', 80, 0);
    expect(got?.id).toBe('near');
  });

  it('skips same-team, frozen, and cloaked players', () => {
    const ally = player({ id: 'ally', team: 'mime', position: { x: 1, y: 0.5, z: 0 } });
    const frozen = player({
      id: 'fz',
      team: 'clown',
      position: { x: 2, y: 0.5, z: 0 },
      frozen: true,
    });
    const cloaked = player({
      id: 'ck',
      team: 'clown',
      position: { x: 3, y: 0.5, z: 0 },
      cloakUntil: 1000,
    });
    const real = player({ id: 'real', team: 'clown', position: { x: 8, y: 0.5, z: 0 } });
    const got = nearestVisibleEnemy(bot, [bot, ally, frozen, cloaked, real], [], 'plane', 80, 0);
    expect(got?.id).toBe('real');
  });

  it('skips enemies occluded by a wall', () => {
    const walls: WallSegment[] = [{ ax: 5, az: -5, bx: 5, bz: 5 }];
    const behind = player({ id: 'behind', team: 'clown', position: { x: 10, y: 0.5, z: 0 } });
    expect(nearestVisibleEnemy(bot, [bot, behind], walls, 'plane', 80, 0)).toBeNull();
  });
});

describe('nearestFrozenAlly', () => {
  const bot = player({ id: 'bot', team: 'mime', position: { x: 0, y: 0.5, z: 0 } });

  it('returns the nearest frozen teammate within the radius', () => {
    const a = player({ id: 'a', team: 'mime', position: { x: 5, y: 0.5, z: 0 }, frozen: true });
    const b = player({ id: 'b', team: 'mime', position: { x: 2, y: 0.5, z: 0 }, frozen: true });
    const r = nearestFrozenAlly(bot, [bot, a, b], 'plane', 80, 22);
    expect(r.target?.id).toBe('b');
    expect(r.dist).toBeCloseTo(2, 6);
  });

  it('ignores unfrozen teammates, enemies, and anyone beyond the radius', () => {
    const awake = player({ id: 'awake', team: 'mime', position: { x: 1, y: 0.5, z: 0 } });
    const enemyFrozen = player({
      id: 'ef',
      team: 'clown',
      position: { x: 1, y: 0.5, z: 0 },
      frozen: true,
    });
    const farFrozen = player({
      id: 'far',
      team: 'mime',
      position: { x: 30, y: 0.5, z: 0 },
      frozen: true,
    });
    const r = nearestFrozenAlly(bot, [bot, awake, enemyFrozen, farFrozen], 'plane', 80, 22);
    expect(r.target).toBeNull();
    expect(r.dist).toBe(Infinity);
  });
});
