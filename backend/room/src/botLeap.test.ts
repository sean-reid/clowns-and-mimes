import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@cm/shared';
import type { WallSegment } from '@cm/shared/labyrinth';
import { shouldLeapTraverse } from './botLeap.ts';

const REACH = 3;
const leap = (bot: Vec2, goal: Vec2, walls: WallSegment[]) =>
  shouldLeapTraverse(bot, goal, walls, 'plane', 80, REACH);

describe('shouldLeapTraverse', () => {
  it('leaps a wall in the way when the landing past it is clear', () => {
    expect(leap({ x: 0, z: 0 }, { x: 6, z: 0 }, [{ ax: 2, az: -3, bx: 2, bz: 3 }])).toBe(true);
  });

  it('does not leap with no walls', () => {
    expect(leap({ x: 0, z: 0 }, { x: 6, z: 0 }, [])).toBe(false);
  });

  it('does not leap a wall beyond reach (landing would not clear it)', () => {
    expect(leap({ x: 0, z: 0 }, { x: 10, z: 0 }, [{ ax: 5, az: -3, bx: 5, bz: 3 }])).toBe(false);
  });

  it('does not leap when the landing point lands on the wall', () => {
    expect(leap({ x: 0, z: 0 }, { x: 6, z: 0 }, [{ ax: 2.8, az: -3, bx: 2.8, bz: 3 }])).toBe(false);
  });

  it('does not leap when the wall is off the line to the goal', () => {
    expect(leap({ x: 0, z: 0 }, { x: 6, z: 0 }, [{ ax: 1, az: 2, bx: 1, bz: 5 }])).toBe(false);
  });
});
