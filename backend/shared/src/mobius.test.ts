import { describe, expect, it } from 'vitest';
import {
  MOBIUS_HALF_X,
  MOBIUS_HALF_Z,
  mobiusExtents,
  pointInMobius,
  stepAcrossMobiusBoundary,
  wrapMobiusPoint,
} from './mobius.ts';
import { MOBIUS_GRID_X, MOBIUS_GRID_Z, generateMobiusGridWalls } from './gridMaze.ts';
import { WORLD_WIDTH } from './topology.ts';

describe('mobiusExtents', () => {
  it('returns 2 * MOBIUS_HALF_X by 2 * MOBIUS_HALF_Z', () => {
    const ext = mobiusExtents();
    expect(ext.x).toBe(2 * MOBIUS_HALF_X);
    expect(ext.z).toBe(2 * MOBIUS_HALF_Z);
  });
});

describe('pointInMobius', () => {
  it('accepts any z inside the strip regardless of x (x is modular)', () => {
    expect(pointInMobius({ x: 0, z: 0 })).toBe(true);
    expect(pointInMobius({ x: 200, z: 0 })).toBe(true);
    expect(pointInMobius({ x: -200, z: MOBIUS_HALF_Z })).toBe(true);
  });

  it('rejects points past the z hard bounds', () => {
    expect(pointInMobius({ x: 0, z: MOBIUS_HALF_Z + 0.1 })).toBe(false);
    expect(pointInMobius({ x: 0, z: -MOBIUS_HALF_Z - 0.1 })).toBe(false);
  });
});

describe('stepAcrossMobiusBoundary', () => {
  it('returns next unchanged inside the strip', () => {
    const out = stepAcrossMobiusBoundary({ x: 0, z: 0 }, { x: 5, z: -3 });
    expect(out.x).toBeCloseTo(5, 6);
    expect(out.z).toBeCloseTo(-3, 6);
  });

  it('wraps x modular at the right edge with NO z-flip', () => {
    // Cross x = +MOBIUS_HALF_X by 0.3. Emerge on the far left with the
    // same z; the Möbius flip is encoded in the maze geometry, not in
    // the wrap rule, so player motion across the seam is smooth.
    const prev = { x: MOBIUS_HALF_X - 0.1, z: 7 };
    const next = { x: MOBIUS_HALF_X + 0.3, z: 7 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBeCloseTo(-MOBIUS_HALF_X + 0.3, 6);
    expect(out.z).toBeCloseTo(7, 6);
  });

  it('wraps x modular at the left edge with NO z-flip', () => {
    const prev = { x: -MOBIUS_HALF_X + 0.1, z: -7 };
    const next = { x: -MOBIUS_HALF_X - 0.3, z: -7 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out.x).toBeCloseTo(MOBIUS_HALF_X - 0.3, 6);
    expect(out.z).toBeCloseTo(-7, 6);
  });

  it('blocks the step past the top hard wall', () => {
    const prev = { x: 0, z: MOBIUS_HALF_Z - 0.1 };
    const next = { x: 0, z: MOBIUS_HALF_Z + 1 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out).toEqual(prev);
  });

  it('blocks the step past the bottom hard wall', () => {
    const prev = { x: 0, z: -MOBIUS_HALF_Z + 0.1 };
    const next = { x: 0, z: -MOBIUS_HALF_Z - 1 };
    const out = stepAcrossMobiusBoundary(prev, next);
    expect(out).toEqual(prev);
  });
});

describe('wrapMobiusPoint', () => {
  it('returns interior points with x wrapped modular', () => {
    expect(wrapMobiusPoint({ x: 3, z: -2 })).toEqual({ x: 3, z: -2 });
    expect(wrapMobiusPoint({ x: MOBIUS_HALF_X + 5, z: 0 }).x).toBeCloseTo(-MOBIUS_HALF_X + 5, 6);
  });

  it('clamps a z-exterior point to the boundary', () => {
    expect(wrapMobiusPoint({ x: 0, z: MOBIUS_HALF_Z + 100 })).toEqual({
      x: 0,
      z: MOBIUS_HALF_Z,
    });
    expect(wrapMobiusPoint({ x: 0, z: -MOBIUS_HALF_Z - 100 })).toEqual({
      x: 0,
      z: -MOBIUS_HALF_Z,
    });
  });
});

describe('generateMobiusGridWalls', () => {
  const seeds = [1, 7, 17, 42, 99, 12345, 0x7fffffff];

  it('emits all wall coordinates within the playfield bounds', () => {
    // The maze must fit inside the cover playfield. No wall coordinate
    // should escape the rectangle [-halfX, halfX] x [-halfZ, halfZ].
    for (const seed of seeds) {
      const walls = generateMobiusGridWalls(seed);
      for (const w of walls) {
        const xs = [w.ax, w.bx];
        const zs = [w.az, w.bz];
        for (const x of xs) {
          expect(x).toBeGreaterThanOrEqual(-MOBIUS_HALF_X - 1e-6);
          expect(x).toBeLessThanOrEqual(MOBIUS_HALF_X + 1e-6);
        }
        for (const z of zs) {
          expect(z).toBeGreaterThanOrEqual(-MOBIUS_HALF_Z - 1e-6);
          expect(z).toBeLessThanOrEqual(MOBIUS_HALF_Z + 1e-6);
        }
      }
    }
  });

  it('produces a single connected cover (no unreachable islands)', () => {
    // BFS through the wall list: start at cover cell (0, 0), visit every
    // neighbour the wall list doesn't block. Modular x at cover col
    // bounds, hard z bounds. The traversal must reach all cover cells.
    for (const seed of seeds) {
      const walls = generateMobiusGridWalls(seed);
      const cols = MOBIUS_GRID_X;
      const rows = MOBIUS_GRID_Z;
      const cellX = (2 * MOBIUS_HALF_X) / cols;
      const cellZ = (2 * MOBIUS_HALF_Z) / rows;
      const halfX = MOBIUS_HALF_X;
      const halfZ = MOBIUS_HALF_Z;
      const wallSet = new Set<string>();
      for (const w of walls) {
        const mx = (w.ax + w.bx) / 2;
        const mz = (w.az + w.bz) / 2;
        const isVertical = Math.abs(w.ax - w.bx) < 1e-6;
        wallSet.add(`${isVertical ? 'v' : 'h'}:${mx.toFixed(3)}:${mz.toFixed(3)}`);
      }
      const wallBlocks = (cx: number, cz: number, dir: 'e' | 'n' | 'w' | 's'): boolean => {
        let key: string;
        if (dir === 'e')
          key = `v:${((cx + 1) * cellX - halfX).toFixed(3)}:${(cz * cellZ - halfZ + cellZ / 2).toFixed(3)}`;
        else if (dir === 'w')
          key = `v:${(cx * cellX - halfX).toFixed(3)}:${(cz * cellZ - halfZ + cellZ / 2).toFixed(3)}`;
        else if (dir === 'n')
          key = `h:${(cx * cellX - halfX + cellX / 2).toFixed(3)}:${((cz + 1) * cellZ - halfZ).toFixed(3)}`;
        else
          key = `h:${(cx * cellX - halfX + cellX / 2).toFixed(3)}:${(cz * cellZ - halfZ).toFixed(3)}`;
        return wallSet.has(key);
      };
      const visited = new Set<number>();
      const queue: number[] = [0];
      visited.add(0);
      while (queue.length > 0) {
        const id = queue.shift()!;
        const cc = id % cols;
        const cr = Math.floor(id / cols);
        if (!wallBlocks(cc, cr, 'e')) {
          const nc = (cc + 1) % cols;
          const nb = nc + cr * cols;
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
        if (!wallBlocks(cc, cr, 'w')) {
          const nc = (cc - 1 + cols) % cols;
          const nb = nc + cr * cols;
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
        if (cr < rows - 1 && !wallBlocks(cc, cr, 'n')) {
          const nb = cc + (cr + 1) * cols;
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
        if (cr > 0 && !wallBlocks(cc, cr, 's')) {
          const nb = cc + (cr - 1) * cols;
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
      expect(visited.size).toBe(cols * rows);
    }
    void WORLD_WIDTH;
  });
});
