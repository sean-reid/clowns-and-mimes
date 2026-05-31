// Portal power-up geometry, server-owned. A portal pair anchors both mouths on
// wall segments: the entry mouth lands on the wall the activating player faces
// (ray-cast from their look yaw), the exit on a random other wall. A player who
// walks within PORTAL_ENTER_RADIUS of either mouth is teleported to the other
// and emerges PORTAL_EXIT_OFFSET off that wall, into the adjacent open cell.
//
// Pure functions so the room can unit-test the geometry without a live DO; the
// client never runs this (it renders the wall-anchored mouth points the server
// puts on the wire).

import type { Topology, Vec2, Vec3 } from './protocol.ts';
import type { WallSegment } from './labyrinth.ts';
import { wrapPosition } from './topology.ts';

// A pair stays open this long before both mouths close.
export const PORTAL_DURATION_MS = 6_000;
// A player within this planar distance of a mouth is pulled through.
export const PORTAL_ENTER_RADIUS = 1.4;
// Emergence drops you this far off the exit wall, into the open cell. Kept
// larger than PORTAL_ENTER_RADIUS so you don't land back inside the mouth you
// just arrived at (which would immediately teleport you back).
export const PORTAL_EXIT_OFFSET = 2.0;
// How far a look-yaw ray probes before giving up on finding a faced wall.
const RAY_MAX = 200;

// Wall-anchored mouth points (a/b) plus the off-wall emergence points a player
// lands on when they arrive at each mouth. Emergence points are canonical.
export interface PortalGeom {
  a: Vec3;
  b: Vec3;
  aExit: Vec3;
  bExit: Vec3;
}

// Forward unit vector for a look yaw, matching the client's body-yaw
// convention in game/scripts/player.gd (target_yaw = atan2(-x, -z)).
export function forwardFromYaw(yaw: number): Vec2 {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

function segDistance(px: number, pz: number, w: WallSegment): number {
  const dx = w.bx - w.ax;
  const dz = w.bz - w.az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-9) return Math.hypot(px - w.ax, pz - w.az);
  let t = ((px - w.ax) * dx + (pz - w.az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (w.ax + dx * t), pz - (w.az + dz * t));
}

function clearance(walls: readonly WallSegment[], x: number, z: number): number {
  let min = Infinity;
  for (const w of walls) {
    const d = segDistance(x, z, w);
    if (d < min) min = d;
  }
  return min;
}

interface WallHit {
  wall: WallSegment;
  x: number;
  z: number;
}

// Nearest forward wall the ray O + t*D crosses (t in [0, RAY_MAX]), or null.
function rayHit(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  walls: readonly WallSegment[],
): (WallHit & { t: number }) | null {
  let best: (WallHit & { t: number }) | null = null;
  for (const w of walls) {
    const ex = w.bx - w.ax;
    const ez = w.bz - w.az;
    const denom = dx * ez - dz * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const t = ((w.ax - ox) * ez - (w.az - oz) * ex) / denom;
    const u = ((w.ax - ox) * dz - (w.az - oz) * dx) / denom;
    if (t < 0 || t > RAY_MAX || u < 0 || u > 1) continue;
    if (best === null || t < best.t) best = { wall: w, x: ox + dx * t, z: oz + dz * t, t };
  }
  return best;
}

// Closest point on the closest wall to (x, z). Fallback entry when the look ray
// finds no wall (player faces an opening).
function nearestWall(walls: readonly WallSegment[], x: number, z: number): WallHit {
  let best: WallHit | null = null;
  let bestD = Infinity;
  for (const w of walls) {
    const dx = w.bx - w.ax;
    const dz = w.bz - w.az;
    const lenSq = dx * dx + dz * dz;
    const t =
      lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - w.ax) * dx + (z - w.az) * dz) / lenSq));
    const cx = w.ax + dx * t;
    const cz = w.az + dz * t;
    const d = Math.hypot(x - cx, z - cz);
    if (d < bestD) {
      bestD = d;
      best = { wall: w, x: cx, z: cz };
    }
  }
  return best!;
}

// Emergence point off a wall mouth. When `toward` is given (the entry mouth, set
// to the activating player's position) we drop on that player's side, which is
// known walkable; otherwise (the random exit) we pick the side with more
// clearance from neighboring walls.
function emerge(
  wall: WallSegment,
  mx: number,
  mz: number,
  toward: Vec2 | null,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
): Vec3 {
  const ex = wall.bx - wall.ax;
  const ez = wall.bz - wall.az;
  const len = Math.hypot(ex, ez) || 1;
  const nx = -ez / len;
  const nz = ex / len;
  const plus = { x: mx + nx * PORTAL_EXIT_OFFSET, z: mz + nz * PORTAL_EXIT_OFFSET };
  const minus = { x: mx - nx * PORTAL_EXIT_OFFSET, z: mz - nz * PORTAL_EXIT_OFFSET };
  let chosen: Vec2;
  if (toward) {
    const side = (toward.x - mx) * nx + (toward.z - mz) * nz;
    chosen = side >= 0 ? plus : minus;
  } else {
    chosen = clearance(walls, plus.x, plus.z) >= clearance(walls, minus.x, minus.z) ? plus : minus;
  }
  const wrapped = wrapPosition(chosen, topology, worldWidth);
  return { x: wrapped.x, y: 0, z: wrapped.z };
}

/**
 * Build a portal pair for a player activating the power-up. Entry mouth lands on
 * the wall they face (or the nearest wall if they face an opening); exit mouth
 * on a random other wall. Returns null only when there are no walls.
 */
export function buildPortalPair(
  origin: Vec2,
  yaw: number,
  walls: readonly WallSegment[],
  topology: Topology,
  worldWidth: number,
  rng: () => number = Math.random,
): PortalGeom | null {
  if (walls.length === 0) return null;
  const f = forwardFromYaw(yaw);
  const hit = rayHit(origin.x, origin.z, f.x, f.z, walls) ?? nearestWall(walls, origin.x, origin.z);
  const entryWall = hit.wall;
  let exitWall = entryWall;
  if (walls.length > 1) {
    do {
      exitWall = walls[Math.floor(rng() * walls.length)]!;
    } while (exitWall === entryWall);
  }
  const bx = (exitWall.ax + exitWall.bx) / 2;
  const bz = (exitWall.az + exitWall.bz) / 2;
  return {
    a: { x: hit.x, y: 0, z: hit.z },
    b: { x: bx, y: 0, z: bz },
    aExit: emerge(entryWall, hit.x, hit.z, origin, walls, topology, worldWidth),
    bExit: emerge(exitWall, bx, bz, null, walls, topology, worldWidth),
  };
}
