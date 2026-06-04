import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@cm/shared';
import { interceptPoint } from './botIntercept.ts';

const lead = (shooter: Vec2, target: Vec2, vel: Vec2, speed: number) =>
  interceptPoint(shooter, target, vel, speed, 'plane', 80);

describe('interceptPoint', () => {
  it('returns the current position for a stationary target', () => {
    const p = lead({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 0 }, 16);
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('returns the current position when speed is non-positive', () => {
    const p = lead({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 5 }, 0);
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('leads ahead of a target crossing the line of fire', () => {
    const p = lead({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 4 }, 16);
    // Lead in the direction of travel (+z), roughly distance/speed * vel.
    expect(p.z).toBeGreaterThan(2);
    expect(p.x).toBeCloseTo(10, 6);
  });

  it('aims nearer than the target when it is closing in', () => {
    const p = lead({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: -4, z: 0 }, 16);
    expect(p.x).toBeLessThan(10);
    expect(p.x).toBeGreaterThan(6);
  });

  it('leads further at a slower closing speed', () => {
    const fast = lead({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 5 }, 16);
    const slow = lead({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 5 }, 6);
    expect(slow.z).toBeGreaterThan(fast.z);
  });
});
