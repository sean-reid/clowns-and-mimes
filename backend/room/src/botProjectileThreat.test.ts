import { describe, expect, it } from 'vitest';
import type { PlayerState, Team } from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import {
  nearestProjectileThreat,
  shouldDodgeProjectile,
  type SightedProjectile,
} from './botProjectileThreat.ts';

const SIGHT = 22;
const LOOKBACK = 12;
const DODGE_RADIUS = 1;
const DODGE_LEAD = 0.35;

function bot(team: Team = 'mime'): PlayerState {
  return {
    id: 'b',
    name: 'b',
    team,
    bot: true,
    position: { x: 0, y: 0.5, z: 0 },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  };
}

function proj(over: Partial<SightedProjectile> & { team: Team }): SightedProjectile {
  return {
    ownerId: 'e',
    position: { x: 8, z: 0 },
    velocity: { x: -16, z: 0 },
    ...over,
  };
}

const threat = (projectiles: SightedProjectile[], walls: WallSegment[] = []) =>
  nearestProjectileThreat(bot(), projectiles, walls, 'plane', 80, SIGHT, LOOKBACK);

describe('nearestProjectileThreat', () => {
  it('flees from a bearing back along an incoming enemy shot’s trajectory', () => {
    // Shot at (8,0) heading -x: it came from +x, so the bearing is 12 further +x.
    const t = threat([proj({ team: 'clown' })]);
    expect(t?.x).toBeCloseTo(20, 4);
    expect(t?.z).toBeCloseTo(0, 4);
  });

  it('does not perceive a shot blocked by a wall (it is sight, not hearing)', () => {
    const walls: WallSegment[] = [{ ax: 4, az: -3, bx: 4, bz: 3 }];
    expect(threat([proj({ team: 'clown' })], walls)).toBeNull();
  });

  it('does not perceive a shot beyond sight range', () => {
    expect(threat([proj({ team: 'clown', position: { x: 30, z: 0 } })])).toBeNull();
  });

  it('ignores a shot flying away (not incoming)', () => {
    expect(threat([proj({ team: 'clown', velocity: { x: 16, z: 0 } })])).toBeNull();
  });

  it('ignores friendly fire and its own shots', () => {
    expect(threat([proj({ team: 'mime' })])).toBeNull();
    expect(threat([proj({ team: 'clown', ownerId: 'b' })])).toBeNull();
  });

  it('takes the bearing of the nearest of several incoming shots', () => {
    const t = threat([
      proj({ ownerId: 'e1', team: 'clown', position: { x: 15, z: 0 } }),
      proj({ ownerId: 'e2', team: 'clown', position: { x: 6, z: 0 } }),
    ]);
    expect(t?.x).toBeCloseTo(18, 4);
  });
});

const dodge = (projectiles: SightedProjectile[], walls: WallSegment[] = []) =>
  shouldDodgeProjectile(bot(), projectiles, walls, 'plane', 80, DODGE_RADIUS, DODGE_LEAD);

describe('shouldDodgeProjectile', () => {
  it('dodges a dead-on shot arriving within the lead window', () => {
    expect(dodge([proj({ team: 'clown', position: { x: 4, z: 0 } })])).toBe(true);
  });

  it('does not dodge a shot passing wide', () => {
    expect(dodge([proj({ team: 'clown', position: { x: 4, z: 5 } })])).toBe(false);
  });

  it('waits on a hit line that is still too far out', () => {
    expect(dodge([proj({ team: 'clown', position: { x: 10, z: 0 } })])).toBe(false);
  });

  it('does not dodge a shot moving away', () => {
    expect(
      dodge([proj({ team: 'clown', position: { x: 4, z: 0 }, velocity: { x: 16, z: 0 } })]),
    ).toBe(false);
  });

  it('does not dodge a shot it cannot see', () => {
    const walls: WallSegment[] = [{ ax: 2, az: -3, bx: 2, bz: 3 }];
    expect(dodge([proj({ team: 'clown', position: { x: 4, z: 0 } })], walls)).toBe(false);
  });

  it('does not dodge friendly fire', () => {
    expect(dodge([proj({ team: 'mime', position: { x: 4, z: 0 } })])).toBe(false);
  });
});
