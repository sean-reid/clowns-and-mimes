import type { Topology, Vec2 } from './protocol.ts';
import {
  MOBIUS_HALF_X,
  mobiusExtents,
  stepAcrossMobiusBoundary,
  wrapMobiusPoint,
} from './mobius.ts';

export const WORLD_WIDTH = 80;

/**
 * Per-topology playfield extents in world units. Klein doubles x for its
 * z-mirrored second half. Plane and torus are plain WxW squares.
 */
export function topologyExtents(topology: Topology, width: number): { x: number; z: number } {
  if (topology === 'klein') return { x: 2 * width, z: width };
  if (topology === 'mobius') {
    void width;
    return mobiusExtents();
  }
  return { x: width, z: width };
}

/**
 * Wrap a position into the canonical domain for the topology.
 * Server and client must agree on this so that rendering, physics, and
 * pathfinding all see the same coordinate space.
 */
export function wrapPosition(p: Vec2, topology: Topology, width: number): Vec2 {
  const half = width / 2;
  switch (topology) {
    case 'plane': {
      return {
        x: clamp(p.x, -half, half),
        z: clamp(p.z, -half, half),
      };
    }
    case 'torus': {
      return {
        x: wrap(p.x, width),
        z: wrap(p.z, width),
      };
    }
    case 'klein': {
      // Double cover: the canonical x domain is 2*width and the second half
      // (mirrored across z=0) is part of the walkable surface. Both axes
      // wrap modular - the Klein topology is embedded in the geometry's
      // z-mirror symmetry, not in an instant flip at the seam.
      return {
        x: wrap(p.x, 2 * width),
        z: wrap(p.z, width),
      };
    }
    case 'mobius': {
      // Möbius strip: x past +/-MOBIUS_HALF_X identifies to the opposite
      // edge with z negated; z stays clamped because top and bottom are
      // hard walls.
      void width;
      return wrapMobiusPoint(p);
    }
  }
}

/**
 * Step-aware wrap. Only Möbius needs the prev->candidate context (so the
 * cylindrical double cover's hard z-bounds reject the step instead of
 * silently clamping). Other topologies behave the same as wrapPosition.
 */
export function wrapPositionFromStep(
  prev: Vec2,
  candidate: Vec2,
  topology: Topology,
  width: number,
): Vec2 {
  if (topology === 'mobius') {
    return stepAcrossMobiusBoundary(prev, candidate);
  }
  return wrapPosition(candidate, topology, width);
}

export function topologyDistance(a: Vec2, b: Vec2, topology: Topology, width: number): number {
  switch (topology) {
    case 'plane':
      return Math.hypot(a.x - b.x, a.z - b.z);
    case 'torus': {
      const dx = wrappedDelta(a.x, b.x, width);
      const dz = wrappedDelta(a.z, b.z, width);
      return Math.hypot(dx, dz);
    }
    case 'klein': {
      // Klein is a 2W*W torus by virtue of the geometric z-mirror symmetry
      // of its right half, so shortest path is plain modular both axes.
      const dx = wrappedDelta(a.x, b.x, 2 * width);
      const dz = wrappedDelta(a.z, b.z, width);
      return Math.hypot(dx, dz);
    }
    case 'mobius': {
      // Möbius cylindrical double cover: x wraps modular at 2*MOBIUS_HALF_X
      // with no flip in the wrap (the flip is baked into the maze geometry).
      // z is plain Euclidean (no wrap; hard top/bottom bounds).
      void width;
      const dx = wrappedDelta(a.x, b.x, 2 * MOBIUS_HALF_X);
      return Math.hypot(dx, a.z - b.z);
    }
  }
}

/**
 * Shortest-path delta from `from` to `to` under the given topology, normalized
 * to a unit vector. Returns (0, 0) when the points coincide. On wrapping
 * topologies this picks the direction that crosses the seam when that is
 * shorter than the in-domain delta; bots that ignore this end up zigzagging
 * at seams because the Euclidean delta points back across the whole arena.
 */
/**
 * Wrap-aware vector delta from `from` to `to`. Returns the shortest
 * signed displacement under the topology's identification (so a torus
 * delta near the seam points across the seam, not around the long way).
 * Caller composes the magnitude as needed.
 */
export function wrappedDeltaVec(from: Vec2, to: Vec2, topology: Topology, width: number): Vec2 {
  switch (topology) {
    case 'plane':
      return { x: to.x - from.x, z: to.z - from.z };
    case 'torus':
      return { x: wrappedDelta(from.x, to.x, width), z: wrappedDelta(from.z, to.z, width) };
    case 'klein':
      return {
        x: wrappedDelta(from.x, to.x, 2 * width),
        z: wrappedDelta(from.z, to.z, width),
      };
    case 'mobius':
      return {
        x: wrappedDelta(from.x, to.x, 2 * MOBIUS_HALF_X),
        z: to.z - from.z,
      };
  }
}

export function wrappedUnitDelta(from: Vec2, to: Vec2, topology: Topology, width: number): Vec2 {
  let dx: number;
  let dz: number;
  switch (topology) {
    case 'plane': {
      dx = to.x - from.x;
      dz = to.z - from.z;
      break;
    }
    case 'torus': {
      dx = wrappedDelta(from.x, to.x, width);
      dz = wrappedDelta(from.z, to.z, width);
      break;
    }
    case 'klein': {
      dx = wrappedDelta(from.x, to.x, 2 * width);
      dz = wrappedDelta(from.z, to.z, width);
      break;
    }
    case 'mobius': {
      // Cylindrical double cover: x is plain modular at 2*MOBIUS_HALF_X,
      // z is plain Euclidean (no wrap). The Möbius "twist" is encoded
      // in the maze geometry, not in the wrap direction.
      void width;
      dx = wrappedDelta(from.x, to.x, 2 * MOBIUS_HALF_X);
      dz = to.z - from.z;
      break;
    }
  }
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return { x: 0, z: 0 };
  return { x: dx / len, z: dz / len };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function wrap(v: number, width: number): number {
  const half = width / 2;
  const w = (((v + half) % width) + width) % width;
  return w - half;
}

function wrappedDelta(a: number, b: number, width: number): number {
  const d = (((b - a) % width) + width) % width;
  return d > width / 2 ? d - width : d;
}
