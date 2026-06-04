import { describe, expect, it } from 'vitest';
import type { PlayerState } from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import {
  bestVisibleEnemy,
  botCanSee,
  isCloaked,
  nearestEnemy,
  nearestFrozenAlly,
  nearestVisibleEnemy,
} from './botPerception.ts';

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

describe('bestVisibleEnemy', () => {
  const bot = player({ id: 'bot', team: 'mime', position: { x: 0, y: 0.5, z: 0 } });

  it('reduces to nearest in the open with no teammates to differentiate', () => {
    const near = player({ id: 'near', team: 'clown', position: { x: 3, y: 0.5, z: 0 } });
    const far = player({ id: 'far', team: 'clown', position: { x: 9, y: 0.5, z: 0 } });
    expect(bestVisibleEnemy(bot, [bot, far, near], [], 'plane', 80, 0)?.id).toBe('near');
  });

  it('applies the same visibility filters as nearestVisibleEnemy', () => {
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
    expect(bestVisibleEnemy(bot, [bot, ally, frozen, cloaked, real], [], 'plane', 80, 0)?.id).toBe(
      'real',
    );
    const walls: WallSegment[] = [{ ax: 5, az: -5, bx: 5, bz: 5 }];
    const behind = player({ id: 'behind', team: 'clown', position: { x: 10, y: 0.5, z: 0 } });
    expect(bestVisibleEnemy(bot, [bot, behind], walls, 'plane', 80, 0)).toBeNull();
  });

  it('prefers an isolated enemy over an equidistant one shielded by a teammate', () => {
    // Both 'shielded' and 'lone' are 6 away, but 'shielded' has an ally right
    // beside it; 'lone' is on its own, so its isolation bonus breaks the tie.
    const shielded = player({ id: 'shielded', team: 'clown', position: { x: 6, y: 0.5, z: 0 } });
    const guard = player({ id: 'guard', team: 'clown', position: { x: 6, y: 0.5, z: 1.5 } });
    const lone = player({ id: 'lone', team: 'clown', position: { x: 0, y: 0.5, z: 6 } });
    expect(bestVisibleEnemy(bot, [bot, shielded, guard, lone], [], 'plane', 80, 0)?.id).toBe(
      'lone',
    );
  });

  it('prefers a wall-cornered enemy over an equidistant one in the open', () => {
    const open = player({ id: 'open', team: 'clown', position: { x: 8, y: 0.5, z: 0 } });
    const cornered = player({ id: 'cornered', team: 'clown', position: { x: -8, y: 0.5, z: 0 } });
    const walls: WallSegment[] = [
      { ax: -11, az: -2, bx: -5, bz: -2 },
      { ax: -10, az: -3, bx: -10, bz: 3 },
    ];
    expect(bestVisibleEnemy(bot, [bot, open, cornered], walls, 'plane', 80, 0)?.id).toBe(
      'cornered',
    );
  });
});

describe('nearestEnemy', () => {
  const bot = player({ id: 'bot', team: 'mime', position: { x: 0, y: 0.5, z: 0 } });

  it('picks the nearest enemy ignoring walls, range, and cloak', () => {
    const walls: WallSegment[] = [{ ax: 5, az: -5, bx: 5, bz: 5 }];
    // Cloaked + occluded + far: all invisible to nearestVisibleEnemy, but radar
    // sees through every filter, so this is still the nearest enemy.
    const cloakedBehind = player({
      id: 'ck',
      team: 'clown',
      position: { x: 10, y: 0.5, z: 0 },
      cloakUntil: 1000,
    });
    const farther = player({ id: 'far', team: 'clown', position: { x: 30, y: 0.5, z: 0 } });
    expect(
      nearestVisibleEnemy(bot, [bot, cloakedBehind, farther], walls, 'plane', 80, 0),
    ).toBeNull();
    const r = nearestEnemy(bot, [bot, cloakedBehind, farther], 'plane', 80);
    expect(r.target?.id).toBe('ck');
    expect(r.dist).toBeCloseTo(10, 6);
  });

  it('skips same-team and frozen players', () => {
    const ally = player({ id: 'ally', team: 'mime', position: { x: 1, y: 0.5, z: 0 } });
    const frozen = player({
      id: 'fz',
      team: 'clown',
      position: { x: 2, y: 0.5, z: 0 },
      frozen: true,
    });
    const real = player({ id: 'real', team: 'clown', position: { x: 8, y: 0.5, z: 0 } });
    const r = nearestEnemy(bot, [bot, ally, frozen, real], 'plane', 80);
    expect(r.target?.id).toBe('real');
  });

  it('returns null when no enemy qualifies', () => {
    const ally = player({ id: 'ally', team: 'mime', position: { x: 1, y: 0.5, z: 0 } });
    const r = nearestEnemy(bot, [bot, ally], 'plane', 80);
    expect(r.target).toBeNull();
    expect(r.dist).toBe(Infinity);
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
