// Wall geometry for the labyrinth. Mirrors game/scripts/labyrinth.gd so server
// and client agree on which segments exist for the same seed. Used by the
// room to collision-test bot movement.
//
// Coordinate convention: XZ plane is the ground, +X right, +Z forward. Wall
// length is along the tangent of the ring at angle `mid`. Length endpoints
// are computed for collision; the visual mesh is built client-side.

import type { Topology } from './protocol.ts';
import { WORLD_WIDTH } from './topology.ts';
import { generateGridMazeWalls } from './gridMaze.ts';

export const WALL_THICKNESS = 0.4;
export const WALL_HALF_THICKNESS = WALL_THICKNESS / 2;
// Bots and players are 0.4-radius capsules. Their visual mesh overlaps a wall
// whenever the body center is closer than (player_radius + wall_half_thickness)
// to the wall centerline. The collision test below uses this combined margin
// so bots cannot end up visually intersecting a wall by hugging it.
export const PLAYER_RADIUS = 0.4;
export const WALL_CLEARANCE = WALL_HALF_THICKNESS + PLAYER_RADIUS;
export const SYMMETRY_ORDER = 12;
export const RING_RADII: readonly number[] = [6, 12, 18, 24, 30, 36];

export interface WallSegment {
  // Centerline endpoints in world XZ coords.
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/**
 * Deterministic 0-or-1 jitter for gap placement. Mirrored verbatim in
 * labyrinth.gd. Pure integer math so GDScript and TS produce identical
 * results from the same (seed, ring_index, gap_k) triple.
 */
export function gapJitter(seed: number, ring: number, k: number): number {
  // 32-bit unsigned multiply-and-mix. The shift+xor steps spread bits enough
  // that adjacent rings or gap indices don't correlate.
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (ring + 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (k + 0x27d4eb2f), 0x165667b1);
  h ^= h >>> 13;
  return Math.abs(h) % 2;
}

function gapsForRing(ringIndex: number): number {
  return Math.max(1, Math.floor(SYMMETRY_ORDER / (2 + ringIndex)));
}

function chooseGapIndices(seed: number, ringIndex: number): Set<number> {
  const segments = SYMMETRY_ORDER;
  const gapCount = gapsForRing(ringIndex);
  const stagger = ringIndex % 2 === 1 ? 1 : 0;
  const step = Math.max(1, Math.floor(segments / gapCount));
  const out = new Set<number>();
  for (let k = 0; k < gapCount; k += 1) {
    const idx = (k * step + stagger + gapJitter(seed, ringIndex, k)) % segments;
    out.add(idx);
  }
  return out;
}

/**
 * Wall centerline endpoints. The visual mesh adds height (Y) and thickness
 * (perpendicular to length); for server-side collision we treat each wall as
 * a thick line segment.
 *
 * Topology dispatch:
 *   - Plane, torus, Klein: grid maze (the only difference is wrap behavior at
 *     the boundary; plane adds closed boundary walls, torus and Klein skip
 *     them).
 *   - Sphere: still the concentric-ring layout pending cube-mapped topology.
 *
 * The default-undefined topology argument keeps the old single-arg signature
 * working for legacy callers that didn't pass topology.
 */
export function generateWalls(seed: number, topology: Topology = 'plane'): WallSegment[] {
  if (topology !== 'sphere') {
    return generateGridMazeWalls(seed, topology);
  }
  const out: WallSegment[] = [];
  const subdivisions = 4;
  for (let ringIndex = 0; ringIndex < RING_RADII.length; ringIndex += 1) {
    const radius = RING_RADII[ringIndex]!;
    const segments = SYMMETRY_ORDER;
    const gaps = chooseGapIndices(seed, ringIndex);
    for (let s = 0; s < segments; s += 1) {
      if (gaps.has(s)) continue;
      const startAngle = (Math.PI * 2 * s) / segments;
      const endAngle = (Math.PI * 2 * (s + 1)) / segments;
      for (let i = 0; i < subdivisions; i += 1) {
        const t0 = i / subdivisions;
        const t1 = (i + 1) / subdivisions;
        const a0 = lerp(startAngle, endAngle, t0);
        const a1 = lerp(startAngle, endAngle, t1);
        const mid = (a0 + a1) / 2;
        const segLen = 2 * radius * Math.sin((a1 - a0) / 2);
        const cx = Math.cos(mid) * radius;
        const cz = Math.sin(mid) * radius;
        // Tangent direction at angle `mid`.
        const tx = -Math.sin(mid);
        const tz = Math.cos(mid);
        out.push({
          ax: cx - tx * (segLen / 2),
          az: cz - tz * (segLen / 2),
          bx: cx + tx * (segLen / 2),
          bz: cz + tz * (segLen / 2),
        });
      }
    }
  }
  return out;
}

/**
 * Does the 2D line segment from (ax, az)->(bx, bz) cross any wall, accounting
 * for the wall's half-thickness? Approximates by treating walls as line
 * segments and inflating the test slightly. Good enough for bot collision at
 * walking speeds.
 */
export function pathCrossesWall(
  walls: readonly WallSegment[],
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  for (const w of walls) {
    if (segmentsIntersect(ax, az, bx, bz, w.ax, w.az, w.bx, w.bz)) {
      return true;
    }
    // Treat a wall as blocked if the move starts or ends within the body
    // radius plus the wall's own half-thickness. Without the body radius the
    // wall check would only stop a bot whose center was inside the wall mesh
    // - by then the visual capsule already overlaps the wall on screen.
    if (
      pointToSegmentDistance(ax, az, w) < WALL_CLEARANCE ||
      pointToSegmentDistance(bx, bz, w) < WALL_CLEARANCE
    ) {
      return true;
    }
  }
  return false;
}

export function topologyExpectedWidth(_t: Topology): number {
  return WORLD_WIDTH;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function segmentsIntersect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const r1 = orient(ax, az, bx, bz, cx, cz);
  const r2 = orient(ax, az, bx, bz, dx, dz);
  const r3 = orient(cx, cz, dx, dz, ax, az);
  const r4 = orient(cx, cz, dx, dz, bx, bz);
  return r1 !== r2 && r3 !== r4;
}

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const v = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (v > 1e-9) return 1;
  if (v < -1e-9) return -1;
  return 0;
}

function pointToSegmentDistance(px: number, pz: number, w: WallSegment): number {
  const dx = w.bx - w.ax;
  const dz = w.bz - w.az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-9) return Math.hypot(px - w.ax, pz - w.az);
  let t = ((px - w.ax) * dx + (pz - w.az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const x = w.ax + dx * t;
  const z = w.az + dz * t;
  return Math.hypot(px - x, pz - z);
}
