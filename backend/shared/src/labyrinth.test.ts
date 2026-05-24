import { describe, expect, it } from 'vitest';
import { gapJitter, generateWalls, pathCrossesWall } from './labyrinth.ts';
import { SPHERE_FACE_CELLS } from './gridMaze.ts';
import { CUBE_FACES, faceWorldRect, FACE_GRID_COLS, FACE_GRID_ROWS } from './sphereCubeMap.ts';
import { SPHERE_FACE_SIDE } from './topology.ts';

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

  it('produces axis-aligned walls on plane (grid maze)', () => {
    const walls = generateWalls(99, 'plane');
    expect(walls.length).toBeGreaterThan(0);
    for (const w of walls) {
      const axisAligned = w.ax === w.bx || w.az === w.bz;
      expect(axisAligned).toBe(true);
    }
  });

  it('produces a non-trivial wall count for the default plane config', () => {
    // A 10x10 grid maze on plane has at most 2 walls per cell (east + north)
    // plus the west and south boundary walls, then the spanning tree opens
    // some up. The number is well-defined for a given seed; sanity-check the
    // ballpark.
    const walls = generateWalls(1, 'plane');
    expect(walls.length).toBeGreaterThan(50);
    expect(walls.length).toBeLessThan(300);
  });

  it('produces axis-aligned walls on a sphere (cube-mapped grid)', () => {
    const walls = generateWalls(7, 'sphere');
    expect(walls.length).toBeGreaterThan(0);
    for (const w of walls) {
      const axisAligned = w.ax === w.bx || w.az === w.bz;
      expect(axisAligned).toBe(true);
    }
  });
});

describe('pathCrossesWall', () => {
  it('blocks at least one straight path across a plane maze', () => {
    // With the new grid layout we can't rely on rings; pick a few diagonals
    // across the whole playfield and require at least one to hit a wall.
    const walls = generateWalls(123, 'plane');
    const blocked = [
      [-39, -39, 39, 39],
      [-39, 39, 39, -39],
      [0, -39, 0, 39],
      [-39, 0, 39, 0],
    ].some(([ax, az, bx, bz]) => pathCrossesWall(walls, ax!, az!, bx!, bz!));
    expect(blocked).toBe(true);
  });

  it('rejects movement that would exit the plane playfield', () => {
    // Plane is fully bounded by grid-maze boundary walls now, so any move
    // crossing x = +-half or z = +-half should be blocked.
    const walls = generateWalls(123, 'plane');
    expect(pathCrossesWall(walls, 0, 0, 50, 0)).toBe(true);
    expect(pathCrossesWall(walls, 0, 0, 0, -50)).toBe(true);
  });
});

describe('generateWalls (plane, torus, klein use grid maze)', () => {
  it('produces axis-aligned walls on a torus', () => {
    const walls = generateWalls(42, 'torus');
    expect(walls.length).toBeGreaterThan(0);
    for (const w of walls) {
      const axisAligned = w.ax === w.bx || w.az === w.bz;
      expect(axisAligned).toBe(true);
    }
  });

  it('places walls around the entire boundary on plane', () => {
    const walls = generateWalls(123, 'plane');
    const half = 40;
    const onLeft = walls.some((w) => w.ax === -half && w.bx === -half);
    const onRight = walls.some((w) => w.ax === half && w.bx === half);
    const onTop = walls.some((w) => w.az === half && w.bz === half);
    const onBottom = walls.some((w) => w.az === -half && w.bz === -half);
    expect(onLeft).toBe(true);
    expect(onRight).toBe(true);
    expect(onTop).toBe(true);
    expect(onBottom).toBe(true);
  });

  it('omits walls on the sphere playfield boundary', () => {
    const walls = generateWalls(7, 'sphere');
    const half = 40;
    const anyOnBoundary = walls.some(
      (w) =>
        (w.ax === -half && w.bx === -half) ||
        (w.ax === half && w.bx === half) ||
        (w.az === half && w.bz === half) ||
        (w.az === -half && w.bz === -half),
    );
    expect(anyOnBoundary).toBe(false);
  });

  it('omits walls along sphere T-net face boundaries', () => {
    // The T-net puts every cube face in its own grid slot; no wall should
    // sit on a face's outer edge because grid-adjacent face seams are open
    // for traversal and void-adjacent seams are open for the cube
    // identification to fire on motion.
    const walls = generateWalls(7, 'sphere');
    const faceEdges: number[] = [];
    for (const face of CUBE_FACES) {
      const r = faceWorldRect(face, SPHERE_FACE_SIDE);
      faceEdges.push(r.xMin, r.xMax, r.zMin, r.zMax);
    }
    // Cell size is SPHERE_FACE_SIDE / SPHERE_FACE_CELLS.
    const cellSize = SPHERE_FACE_SIDE / SPHERE_FACE_CELLS;
    for (const w of walls) {
      const isVerticalSeg = w.ax === w.bx;
      const isHorizontalSeg = w.az === w.bz;
      if (isVerticalSeg) {
        for (const e of faceEdges) {
          // Only check x-aligned edges (vertical walls live on x = const lines).
          if (Math.abs(e) < FACE_GRID_COLS * SPHERE_FACE_SIDE) {
            // Walls land on the cell grid; a face's outer edge falls on
            // multiples of SPHERE_FACE_SIDE relative to the playfield
            // origin. Use a slack of cellSize/2 to allow interior walls
            // close to but not on the face boundary.
            expect(Math.abs(w.ax - e)).not.toBeLessThan(cellSize / 4);
          }
        }
      }
      if (isHorizontalSeg) {
        for (const e of faceEdges) {
          if (Math.abs(e) < FACE_GRID_ROWS * SPHERE_FACE_SIDE) {
            expect(Math.abs(w.az - e)).not.toBeLessThan(cellSize / 4);
          }
        }
      }
    }
  });

  it('produces different walls for sphere and torus at the same seed', () => {
    // Six independent face mazes traverse a different topology than one big
    // wrapping grid, so the resulting wall lists must diverge.
    const s = generateWalls(2026, 'sphere');
    const t = generateWalls(2026, 'torus');
    expect(s).not.toEqual(t);
  });

  it('skips walls along the wrap seam', () => {
    // The grid maze should never put a wall on the outermost boundary of the
    // playfield, since the topology already collapses both edges to the same
    // line on a wrap surface. Picking up such a wall would visually double up.
    // Klein's playfield is the double cover: x in [-W, W], z in [-W/2, W/2].
    const walls = generateWalls(7, 'klein');
    const halfX = 80; // klein x-extent is 2 * WORLD_WIDTH, so half is W
    const halfZ = 40; // klein z-extent is WORLD_WIDTH, so half is W/2
    for (const w of walls) {
      const onLeft = w.ax === -halfX && w.bx === -halfX;
      const onRight = w.ax === halfX && w.bx === halfX;
      const onTop = w.az === halfZ && w.bz === halfZ;
      const onBottom = w.az === -halfZ && w.bz === -halfZ;
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
