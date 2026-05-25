import { describe, expect, it } from 'vitest';
import { gapJitter, generateWalls, pathCrossesWall } from './labyrinth.ts';
import {
  ADJACENCY,
  FACE_SLOTS,
  faceWorldRect,
  isWalkable,
  type FaceId,
} from './sphereRhombicuboctahedron.ts';
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

  it('keeps shared edges between two walkable sphere faces wall-free', () => {
    // Rhombicuboctahedron unfold: when two walkable cells sit next to
    // each other in the unfold (e.g., +Z and ePYs, or +Z and eS), the
    // shared edge must be open so the player can walk between them.
    // Equivalently: no wall lies inside the shared-edge segment between
    // any two walkable unfold-neighbour cells.
    const walls = generateWalls(7, 'sphere');
    const neighbourAt = (col: number, row: number): FaceId | null => {
      for (const f of Object.keys(FACE_SLOTS)) {
        const s = FACE_SLOTS[f]!;
        if (s.col === col && s.row === row) return f as FaceId;
      }
      return null;
    };
    type Seg = { vertical: boolean; coord: number; from: number; to: number };
    const openSegments: Seg[] = [];
    for (const face of Object.keys(FACE_SLOTS)) {
      if (!isWalkable(face)) continue;
      const r = faceWorldRect(face as FaceId, SPHERE_FACE_SIDE);
      const slot = FACE_SLOTS[face]!;
      const east = neighbourAt(slot.col + 1, slot.row);
      const north = neighbourAt(slot.col, slot.row - 1);
      // Only emit each shared edge once: take the east and north sides
      // (avoids double-counting the same boundary from both faces).
      if (east && isWalkable(east)) {
        openSegments.push({ vertical: true, coord: r.xMax, from: r.zMin, to: r.zMax });
      }
      if (north && isWalkable(north)) {
        openSegments.push({ vertical: false, coord: r.zMax, from: r.xMin, to: r.xMax });
      }
    }
    for (const w of walls) {
      const isVertical = w.ax === w.bx;
      for (const seg of openSegments) {
        if (seg.vertical !== isVertical) continue;
        if (isVertical) {
          if (Math.abs(w.ax - seg.coord) > 1e-6) continue;
          const wMin = Math.min(w.az, w.bz);
          const wMax = Math.max(w.az, w.bz);
          // Overlap test: wall's z range intersects the open segment.
          expect(wMax <= seg.from + 1e-6 || wMin >= seg.to - 1e-6).toBe(true);
        } else {
          if (Math.abs(w.az - seg.coord) > 1e-6) continue;
          const wMin = Math.min(w.ax, w.bx);
          const wMax = Math.max(w.ax, w.bx);
          expect(wMax <= seg.from + 1e-6 || wMin >= seg.to - 1e-6).toBe(true);
        }
      }
    }
  });

  it('emits perimeter walls between sphere walkable faces and triangle barriers', () => {
    // Every edge of a walkable cell that has no ADJACENCY entry borders
    // either an unfold-adjacent triangle or an off-net void that maps to
    // a triangle in 3D. Each such edge must show up in the wall list so
    // collision blocks the player at the barrier.
    const walls = generateWalls(11, 'sphere');
    let expected = 0;
    for (const face of Object.keys(ADJACENCY)) {
      const faceAdj = ADJACENCY[face]!;
      for (const edge of ['east', 'west', 'north', 'south'] as const) {
        if (faceAdj[edge] === undefined) expected += 1;
      }
    }
    // Inspect each face perimeter to count walls that land on its outer
    // boundary. We expect exactly `expected` perimeter wall segments.
    let perimeterHits = 0;
    for (const face of Object.keys(ADJACENCY)) {
      const r = faceWorldRect(face as FaceId, SPHERE_FACE_SIDE);
      const faceAdj = ADJACENCY[face]!;
      for (const w of walls) {
        // Vertical seg matching east/west boundary spanning the full cell?
        if (w.ax === w.bx && Math.abs(w.az - r.zMin) < 1e-6 && Math.abs(w.bz - r.zMax) < 1e-6) {
          if (Math.abs(w.ax - r.xMax) < 1e-6 && faceAdj.east === undefined) perimeterHits += 1;
          if (Math.abs(w.ax - r.xMin) < 1e-6 && faceAdj.west === undefined) perimeterHits += 1;
        }
        if (w.az === w.bz && Math.abs(w.ax - r.xMin) < 1e-6 && Math.abs(w.bx - r.xMax) < 1e-6) {
          if (Math.abs(w.az - r.zMax) < 1e-6 && faceAdj.north === undefined) perimeterHits += 1;
          if (Math.abs(w.az - r.zMin) < 1e-6 && faceAdj.south === undefined) perimeterHits += 1;
        }
      }
    }
    expect(perimeterHits).toBe(expected);
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
