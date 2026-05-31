import { describe, expect, it } from 'vitest';
import {
  PORTAL_ENTER_RADIUS,
  PORTAL_EXIT_OFFSET,
  PORTAL_MOUTH_RADIUS,
  buildPortalPair,
  forwardFromYaw,
} from './portals.ts';
import { pointBlockedByWall, type WallSegment } from './labyrinth.ts';
import type { Vec3 } from './protocol.ts';

// One wall a player at the origin faces (yaw 0 -> -z) and one elsewhere, so the
// exit lands on a different wall than the entry.
const WALLS: WallSegment[] = [
  { ax: -2, az: -3, bx: 2, bz: -3 },
  { ax: -2, az: 10, bx: 2, bz: 10 },
];

function planarDist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('forwardFromYaw', () => {
  it('faces -z at yaw 0 (matches player.gd atan2(-x, -z))', () => {
    const f = forwardFromYaw(0);
    expect(f.x).toBeCloseTo(0, 10);
    expect(f.z).toBeCloseTo(-1, 10);
  });

  it('faces -x at yaw PI/2', () => {
    const f = forwardFromYaw(Math.PI / 2);
    expect(f.x).toBeCloseTo(-1, 10);
    expect(f.z).toBeCloseTo(0, 10);
  });
});

describe('buildPortalPair', () => {
  it('returns null when there are no walls', () => {
    expect(buildPortalPair({ x: 0, z: 0 }, 0, [], 'plane', 80)).toBeNull();
  });

  it('anchors the entry on the faced wall and the exit on another wall', () => {
    const g = buildPortalPair({ x: 0, z: 0 }, 0, WALLS, 'plane', 80)!;
    expect(g.a.x).toBeCloseTo(0, 6);
    expect(g.a.z).toBeCloseTo(-3, 6);
    expect(g.b.z).toBeCloseTo(10, 6);
  });

  it('emerges off the wall farther than the enter radius so you do not bounce back', () => {
    const g = buildPortalPair({ x: 0, z: 0 }, 0, WALLS, 'plane', 80)!;
    expect(planarDist(g.aExit, g.a)).toBeCloseTo(PORTAL_EXIT_OFFSET, 6);
    expect(planarDist(g.aExit, g.a)).toBeGreaterThan(PORTAL_ENTER_RADIUS);
    expect(planarDist(g.bExit, g.b)).toBeGreaterThan(PORTAL_ENTER_RADIUS);
  });

  it('drops the entry emergence on the activating player side of the wall', () => {
    // Player at z=0 faces the z=-3 wall; emergence must stay on the +z side.
    const g = buildPortalPair({ x: 0, z: 0 }, 0, WALLS, 'plane', 80)!;
    expect(g.aExit.z).toBeGreaterThan(g.a.z);
  });

  it('falls back to the nearest wall when the look ray finds none', () => {
    // From (0,3) facing -x (yaw PI/2) no wall lies along the ray, so the
    // nearest wall anchors the entry instead of returning null.
    const g = buildPortalPair({ x: 0, z: 3 }, Math.PI / 2, WALLS, 'plane', 80);
    expect(g).not.toBeNull();
    expect(g!.a.z).toBeCloseTo(-3, 6);
  });

  it('faces the emerging player away from the exit wall', () => {
    // Entry mouth sits on the z=-3 wall; emergence is on the +z (player) side,
    // so the exit yaw must look +z (forward (0, 1)) rather than into the wall.
    const g = buildPortalPair({ x: 0, z: 0 }, 0, WALLS, 'plane', 80)!;
    const f = forwardFromYaw(g.aExitYaw);
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.z).toBeCloseTo(1, 6);
  });

  it('keeps both emergence points clear of a wall on the plane perimeter', () => {
    // The plane CLAMPS x/z to [-40, 40], so a perimeter wall sits where a point
    // pushed off it outward gets clamped back onto the wall. Player faces the
    // interior z=-3 wall (entry); the only other wall is the top edge at z=40
    // (exit). The exit emergence must land on the interior side, not be clamped
    // into the boundary wall it anchors on (the #177 strand-in-wall bug).
    const walls: WallSegment[] = [
      { ax: -2, az: -3, bx: 2, bz: -3 },
      { ax: -40, az: 40, bx: 40, bz: 40 },
    ];
    const g = buildPortalPair({ x: 0, z: 0 }, 0, walls, 'plane', 80)!;
    expect(g.b.z).toBeCloseTo(40, 6);
    expect(g.bExit.z).toBeLessThan(40);
    expect(pointBlockedByWall(walls, g.bExit.x, g.bExit.z)).toBe(false);
    expect(pointBlockedByWall(walls, g.aExit.x, g.aExit.z)).toBe(false);
  });

  it('insets the entry mouth from a wall end so the ring does not overhang', () => {
    // Facing -z from near the wall's +x end (x=1.9 on a segment spanning
    // x[-2,2]) hits at x=1.9, 0.1 from the end. The mouth is pulled inward to
    // sit a full ring radius from the corner.
    const g = buildPortalPair({ x: 1.9, z: 0 }, 0, WALLS, 'plane', 80)!;
    expect(g.a.x).toBeCloseTo(2 - PORTAL_MOUTH_RADIUS, 6);
  });
});
