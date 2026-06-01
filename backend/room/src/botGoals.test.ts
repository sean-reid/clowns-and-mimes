import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@cm/shared';
import { nearestItemTarget, portalEscapeTarget } from './botGoals.ts';

function item(x: number, z: number): { position: Vec3 } {
  return { position: { x, y: 0, z } };
}

describe('nearestItemTarget', () => {
  it('returns the closest item inside the seek radius', () => {
    const got = nearestItemTarget(
      { x: 0, z: 0 },
      [item(10, 0), item(4, 0), item(8, 0)],
      'plane',
      80,
      16,
    );
    expect(got).toEqual({ x: 4, z: 0 });
  });

  it('ignores items beyond the seek radius', () => {
    expect(nearestItemTarget({ x: 0, z: 0 }, [item(20, 0)], 'plane', 80, 16)).toBeNull();
  });

  it('returns null when there are no items', () => {
    expect(nearestItemTarget({ x: 0, z: 0 }, [], 'plane', 80, 16)).toBeNull();
  });

  it('drops the y component, returning a planar Vec2', () => {
    const got = nearestItemTarget({ x: 0, z: 0 }, [item(3, 4)], 'plane', 80, 16);
    expect(got).toEqual({ x: 3, z: 4 });
  });
});

describe('portalEscapeTarget', () => {
  // Bot at origin fleeing in +x (away from a pursuer behind it at -x).
  const botPos = { x: 0, z: 0 };
  const away = { x: 1, z: 0 };

  it('aims for the entry mouth when it is ahead and on the entry side', () => {
    const entry = { x: 5, z: 0 };
    const exit = { x: 30, z: 0 };
    expect(portalEscapeTarget(botPos, away, entry, exit, 'plane', 80)).toEqual({ x: 5, z: 0 });
  });

  it('ignores the portal once the bot is nearer the exit (post-teleport, no bounce)', () => {
    // Bot has emerged by the exit; entry is now the far mouth.
    const entry = { x: -20, z: 0 };
    const exit = { x: 2, z: 0 };
    expect(portalEscapeTarget(botPos, away, entry, exit, 'plane', 80)).toBeNull();
  });

  it('ignores the entry mouth when reaching it means doubling back toward the pursuer', () => {
    // Entry is behind the bot (-x), the direction the pursuer is in.
    const entry = { x: -5, z: 0 };
    const exit = { x: 30, z: 0 };
    expect(portalEscapeTarget(botPos, away, entry, exit, 'plane', 80)).toBeNull();
  });
});
