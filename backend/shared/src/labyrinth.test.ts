import { describe, expect, it } from 'vitest';
import { gapJitter, generateWalls, pathCrossesWall, RING_RADII } from './labyrinth.ts';

describe('gapJitter', () => {
  it('returns 0 or 1', () => {
    for (let i = 0; i < 100; i += 1) {
      const v = gapJitter(i * 13 + 7, i % 6, i % 4);
      expect(v === 0 || v === 1).toBe(true);
    }
  });

  it('is deterministic for the same triple', () => {
    expect(gapJitter(42, 2, 1)).toBe(gapJitter(42, 2, 1));
  });

  it('changes when any input changes', () => {
    const base = gapJitter(42, 2, 1);
    const distinct = new Set([base]);
    distinct.add(gapJitter(43, 2, 1));
    distinct.add(gapJitter(42, 3, 1));
    distinct.add(gapJitter(42, 2, 2));
    // Across nearby inputs at least one differs.
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe('generateWalls', () => {
  it('produces the same wall list for the same seed', () => {
    const a = generateWalls(12345);
    const b = generateWalls(12345);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toEqual(b[i]);
    }
  });

  it('places every wall on one of the configured ring radii', () => {
    const walls = generateWalls(99);
    for (const w of walls) {
      const midX = (w.ax + w.bx) / 2;
      const midZ = (w.az + w.bz) / 2;
      const radius = Math.hypot(midX, midZ);
      const onRing = RING_RADII.some((r) => Math.abs(r - radius) < 0.01);
      expect(onRing).toBe(true);
    }
  });

  it('produces a reasonable wall count for the default config', () => {
    const walls = generateWalls(1);
    // 6 rings * 12 segments * 4 subdivisions = 288 max, minus gap subdivisions.
    expect(walls.length).toBeGreaterThan(150);
    expect(walls.length).toBeLessThan(288);
  });
});

describe('pathCrossesWall', () => {
  const walls = generateWalls(123);

  it('blocks at least one radial path from the center to the outer edge', () => {
    // The labyrinth has gap connectors so not every angle is blocked, but at
    // least some radial sweep must cross a wall. If none do the maze has no
    // walls at all.
    const angles = [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8];
    const blocked = angles.some((a) =>
      pathCrossesWall(walls, 0, 0, 40 * Math.cos(a), 40 * Math.sin(a)),
    );
    expect(blocked).toBe(true);
  });

  it('allows a path that stays inside the innermost ring', () => {
    expect(pathCrossesWall(walls, 0, 0, 1, 1)).toBe(false);
  });
});

describe('generateWalls (torus and klein use grid maze)', () => {
  it('produces axis-aligned walls on a torus', () => {
    const walls = generateWalls(42, 'torus');
    expect(walls.length).toBeGreaterThan(0);
    for (const w of walls) {
      const axisAligned = w.ax === w.bx || w.az === w.bz;
      expect(axisAligned).toBe(true);
    }
  });

  it('skips walls along the wrap seam', () => {
    // The grid maze should never put a wall on the outermost boundary of the
    // playfield, since the topology already collapses both edges to the same
    // line on a wrap surface. Picking up such a wall would visually double up.
    const walls = generateWalls(7, 'klein');
    const half = 40; // WORLD_WIDTH / 2
    for (const w of walls) {
      const onLeft = w.ax === -half && w.bx === -half;
      const onRight = w.ax === half && w.bx === half;
      const onTop = w.az === half && w.bz === half;
      const onBottom = w.az === -half && w.bz === -half;
      expect(onLeft || onRight || onTop || onBottom).toBe(false);
    }
  });

  it('is deterministic across calls for the same seed and topology', () => {
    const a = generateWalls(99, 'torus');
    const b = generateWalls(99, 'torus');
    expect(a).toEqual(b);
  });

  it('torus and klein at the same seed differ', () => {
    // Klein flips the row index when crossing the x-seam, so the spanning
    // tree explores a different cell set and the wall list cannot match.
    const t = generateWalls(2026, 'torus');
    const k = generateWalls(2026, 'klein');
    expect(t).not.toEqual(k);
  });
});
