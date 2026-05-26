import { describe, expect, it } from 'vitest';
import {
  gapJitter,
  generateWalls,
  pathCrossesWall,
  pointBlockedByWall,
  PLAYER_RADIUS,
  WALL_CLEARANCE,
  type WallSegment,
} from './labyrinth.ts';

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

  it('allows escape from inside the wall-clearance band', () => {
    // Stuck-detector telemetry showed bodies ending up ~0.55 m from a wall
    // (just inside WALL_CLEARANCE = 0.6 m) after rounding on a fast tick or
    // a topology wrap teleport, then refusing every candidate move because
    // the old start-position check rejected the entire path. With the start
    // check removed, the body must be able to:
    //   - move PARALLEL to the wall while still inside the clearance band
    //   - move AWAY from the wall (the only way to recover)
    // The end-position check still blocks moving further INTO the wall, and
    // the segment-intersection test still blocks tunneling through it.
    const wall: WallSegment = { ax: -10, az: 0, bx: 10, bz: 0 };
    // Body sitting at z = 0.55 m, just inside clearance of the wall at z = 0.
    const inside = (bx: number, bz: number) => pathCrossesWall([wall], 0, 0.55, bx, bz);
    // Parallel along x, same depth: allowed.
    expect(inside(1, 0.55)).toBe(false);
    // Away from the wall (z increasing): allowed once end clears the band.
    expect(inside(0, 1.0)).toBe(false);
    // Toward the wall (z decreasing): blocked - end is even deeper.
    expect(inside(0, 0.3)).toBe(true);
    // Tunneling straight through to the other side: blocked by segment
    // intersection, not by start-position.
    expect(inside(0, -1.0)).toBe(true);
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

describe('pointBlockedByWall', () => {
  const wall: WallSegment = { ax: 0, az: -5, bx: 0, bz: 5 };

  it('rejects a point sitting directly on the wall segment', () => {
    expect(pointBlockedByWall([wall], 0, 0)).toBe(true);
  });

  it('rejects a point closer than WALL_CLEARANCE perpendicular to the wall', () => {
    // A player disc just inside the clearance band overlaps the wall body.
    expect(pointBlockedByWall([wall], WALL_CLEARANCE - 0.05, 0)).toBe(true);
  });

  it('accepts a point one player diameter clear of the wall', () => {
    // Just outside clearance: collision system would not stop a player here,
    // so neither should the spawn validator.
    expect(pointBlockedByWall([wall], WALL_CLEARANCE + 0.05, 0)).toBe(false);
    expect(pointBlockedByWall([wall], -WALL_CLEARANCE - 0.05, 0)).toBe(false);
  });

  it('accepts a point well past the wall endpoint', () => {
    // The segment runs z in [-5, 5]; (0, 10) is past the end with no nearby
    // wall body. Distance to segment is 5, much more than WALL_CLEARANCE.
    expect(pointBlockedByWall([wall], 0, 10)).toBe(false);
  });

  it('returns false for an empty wall list', () => {
    expect(pointBlockedByWall([], 0, 0)).toBe(false);
  });

  it('flags any spawn point inside a generated plane maze that sits on a wall', () => {
    // For a plane maze, every emitted wall segment's midpoint should be
    // flagged as blocked. Sanity check that the predicate sees real maze
    // walls.
    const walls = generateWalls(1, 'plane');
    expect(walls.length).toBeGreaterThan(0);
    for (const w of walls) {
      const mx = (w.ax + w.bx) / 2;
      const mz = (w.az + w.bz) / 2;
      expect(pointBlockedByWall(walls, mx, mz)).toBe(true);
    }
    void PLAYER_RADIUS;
  });
});
