import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@cm/shared';
import { pathClearsWalls, pathCrossesWall, type WallSegment } from '@cm/shared/labyrinth';
import { BotPathfinder } from './botPathfinder.ts';

// Plane grid: 10x10 cells over an 80-wide world, so each cell is 8 units and
// the half-extent is 40. Cell (c, r) center = ((c+0.5)*8 - 40, (r+0.5)*8 - 40).
const CELL = 8;
const HALF = 40;
function center(c: number, r: number): Vec2 {
  return { x: (c + 0.5) * CELL - HALF, z: (r + 0.5) * CELL - HALF };
}

describe('BotPathfinder string-pulling', () => {
  it('collapses a clear straight corridor to the real target (no stair-stepping)', () => {
    const pf = new BotPathfinder([], 'plane');
    const from = center(1, 5);
    const to = center(8, 5); // same row, many cells away, full line of sight
    const wp = pf.nextWaypoint(from, to);
    // With nothing blocking, the funnel sees all the way to `to` and returns
    // it verbatim rather than the next cell center.
    expect(wp.x).toBeCloseTo(to.x, 6);
    expect(wp.z).toBeCloseTo(to.z, 6);
  });

  it('returns the destination unchanged when both points share a cell', () => {
    const pf = new BotPathfinder([], 'plane');
    const from = { x: 0.1, z: 0.2 };
    const to = { x: 0.5, z: -0.3 };
    expect(pf.nextWaypoint(from, to)).toBe(to);
  });

  it('routes around a wall and returns a waypoint it actually has sight of', () => {
    // A vertical wall on the x = 0 cell boundary spanning most of the field,
    // with a gap at the top so a path exists around it. The wall sits exactly
    // on a grid column boundary so it severs cell edges.
    const walls: WallSegment[] = [{ ax: 0, az: -HALF, bx: 0, bz: HALF - 2 * CELL }];
    const pf = new BotPathfinder(walls, 'plane');
    const from = center(2, 2); // left of the wall
    const to = center(7, 2); // right of the wall, directly across (blocked)
    expect(pathCrossesWall(walls, from.x, from.z, to.x, to.z)).toBe(true);
    const wp = pf.nextWaypoint(from, to);
    // The funnel must hand back a waypoint the bot can see in a straight line;
    // otherwise it would aim through the wall.
    expect(wp).not.toBe(to);
    expect(pathCrossesWall(walls, from.x, from.z, wp.x, wp.z)).toBe(false);
    // Stronger: the body must clear the wall along the whole line, not merely
    // avoid crossing it. A waypoint that only skims the tip would pin the bot.
    expect(pathClearsWalls(walls, from.x, from.z, wp.x, wp.z)).toBe(true);
  });

  it('does not shortcut to a waypoint that skims a wall tip within the body radius', () => {
    // Wall on the x = 0 boundary with a gap up top (tip at z = HALF - 2*CELL).
    // A bot below-left aiming at a cell up-right would, with a crossing-only
    // funnel, shortcut a diagonal that grazes the tip; the clearance-aware
    // funnel must instead return a nearer waypoint the body can actually reach.
    const tipZ = HALF - 2 * CELL;
    const walls: WallSegment[] = [{ ax: 0, az: -HALF, bx: 0, bz: tipZ }];
    const pf = new BotPathfinder(walls, 'plane');
    const from = center(3, 6); // left of the wall, below the tip
    const to = center(6, 8); // right of the wall, above the tip
    const wp = pf.nextWaypoint(from, to);
    expect(pathClearsWalls(walls, from.x, from.z, wp.x, wp.z)).toBe(true);
  });

  it('falls back to the target when it is walled off entirely', () => {
    // Box cell (5,5) in on all four boundaries: unreachable from outside.
    const x0 = 5 * CELL - HALF; // left boundary of col 5
    const x1 = 6 * CELL - HALF;
    const z0 = 5 * CELL - HALF;
    const z1 = 6 * CELL - HALF;
    const walls: WallSegment[] = [
      { ax: x0, az: z0, bx: x1, bz: z0 },
      { ax: x0, az: z1, bx: x1, bz: z1 },
      { ax: x0, az: z0, bx: x0, bz: z1 },
      { ax: x1, az: z0, bx: x1, bz: z1 },
    ];
    const pf = new BotPathfinder(walls, 'plane');
    const from = center(1, 1);
    const to = center(5, 5);
    expect(pf.nextWaypoint(from, to)).toBe(to);
  });

  it('cellCenterOf snaps a position to its cell center', () => {
    const pf = new BotPathfinder([], 'plane');
    const c = pf.cellCenterOf({ x: -35.5, z: -35.2 }); // inside cell (0,0)
    expect(c.x).toBeCloseTo(center(0, 0).x, 6);
    expect(c.z).toBeCloseTo(center(0, 0).z, 6);
  });

  it('exposes cellCount + cellCenterAt for full-extent patrol sampling', () => {
    const pf = new BotPathfinder([], 'plane');
    expect(pf.cellCount()).toBe(100); // 10x10 plane grid
    const c = pf.cellCenterAt(2 + 5 * 10); // cell (2, 5)
    expect(c.x).toBeCloseTo(center(2, 5).x, 6);
    expect(c.z).toBeCloseTo(center(2, 5).z, 6);
  });
});

describe('BotPathfinder avoidance', () => {
  it('routes around a player standing in the straight-line cell', () => {
    const pf = new BotPathfinder([], 'plane');
    const from = center(1, 5);
    const to = center(4, 5);
    // A player parked at the center of (2,5) and (3,5). The avoidance radius is
    // under one cell, so this penalizes those two cells (not their neighbors);
    // the detour must leave row 5.
    const blocked = [2 + 5 * 10, 3 + 5 * 10];
    const avoid = blocked.map((c) => center(c % 10, Math.floor(c / 10)));
    const wp = pf.nextWaypointAvoiding(from, to, avoid);
    const wpCell = pf.cellAt(wp);
    expect(blocked).not.toContain(wpCell);
    // The waypoint should not be the straight-ahead next cell (2,5).
    expect(wpCell).not.toBe(2 + 5 * 10);
  });

  it('still routes through occupied cells when they are the only way (soft, not hard)', () => {
    // Same wall-with-a-gap geometry as the detour test: the only route from the
    // left of the wall to the right bends around the tip. Mark every cell along
    // that detour occupied. A hard block would make the destination unreachable
    // and the search would give up (returning the raw target); the soft cost
    // must instead route through, handing back a real around-the-tip waypoint.
    const walls: WallSegment[] = [{ ax: 0, az: -HALF, bx: 0, bz: HALF - 2 * CELL }];
    const pf = new BotPathfinder(walls, 'plane');
    const from = center(2, 2);
    const to = center(7, 2);
    const fromCell = pf.cellAt(from);
    const toCell = pf.cellAt(to);
    // A player parked in every cell except the endpoints, so any route must
    // cross occupancy.
    const occupied: Vec2[] = [];
    for (let cell = 0; cell < 100; cell += 1) {
      if (cell !== fromCell && cell !== toCell)
        occupied.push(center(cell % 10, Math.floor(cell / 10)));
    }
    const wp = pf.nextWaypointAvoiding(from, to, occupied);
    // It found a path despite the occupancy: the waypoint rounds the wall (it is
    // not the raw target, which the bot can't see through the wall) and the body
    // can reach it.
    expect(wp).not.toBe(to);
    expect(pathClearsWalls(walls, from.x, from.z, wp.x, wp.z)).toBe(true);
  });
});
