import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import { topologyDistance } from '@cm/shared/topology';
import { pathCrossesWall } from '@cm/shared/labyrinth';
import { bestFleeTarget } from './botFlee.ts';

const PROJECTION = 12;
const flee = (bot: Vec2, threat: Vec2, enemies: Vec2[], walls: WallSegment[] = []) =>
  bestFleeTarget(bot, threat, enemies, walls, 'plane', 80, PROJECTION);

describe('bestFleeTarget', () => {
  it('flees straight away from a lone threat on open ground', () => {
    // Threat at +x, so the away point is at -x, a projection out.
    const goal = flee({ x: 0, z: 0 }, { x: 5, z: 0 }, [{ x: 5, z: 0 }]);
    expect(goal.x).toBeCloseTo(-PROJECTION, 4);
    expect(goal.z).toBeCloseTo(0, 4);
  });

  it('redirects away from a second enemy lying along the escape vector', () => {
    // Straight-away (-x) runs into a second enemy at (-10,0); the chosen point
    // must stay clear of it, not bolt toward it.
    const enemies = [
      { x: 5, z: 0 },
      { x: -10, z: 0 },
    ];
    const goal = flee({ x: 0, z: 0 }, { x: 5, z: 0 }, enemies);
    const distToSecond = topologyDistance(goal, { x: -10, z: 0 }, 'plane', 80);
    // The naive straight-away point would be ~2 units from the second enemy;
    // the redirect keeps real distance.
    expect(distToSecond).toBeGreaterThan(8);
  });

  it('avoids a dead-end: never flees straight into a blocking wall', () => {
    const walls: WallSegment[] = [{ ax: -6, az: -4, bx: -6, bz: 4 }];
    const bot = { x: 0, z: 0 };
    const goal = flee(bot, { x: 5, z: 0 }, [{ x: 5, z: 0 }], walls);
    // The chosen escape must be reachable in a straight line (the blocked
    // straight-away candidate carries a heavy penalty).
    expect(pathCrossesWall(walls, bot.x, bot.z, goal.x, goal.z)).toBe(false);
  });
});
