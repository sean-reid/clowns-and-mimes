import type { Topology, Vec2 } from './protocol.ts';

export const WORLD_WIDTH = 80;

/**
 * Wrap a position into the canonical domain for the topology.
 * The domain is the centered square [-w/2, w/2] x [-w/2, w/2].
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
      const wrappedX = wrap(p.x, width);
      const xCrossings = Math.floor((p.x + half) / width);
      const flipZ = xCrossings % 2 !== 0;
      const z0 = flipZ ? -p.z : p.z;
      return {
        x: wrappedX,
        z: wrap(z0, width),
      };
    }
    case 'sphere': {
      // First-cut sphere uses torus-like modular wrap. The 3x2 face packing
      // fills the full playfield, so modular wrap is the right primitive for
      // crossing between faces - close enough to the eventual cube-mapped
      // adjacency to feel right at small step sizes.
      // TODO: proper cube-net edge adjacency with the right rotations when
      // crossing a face boundary.
      return {
        x: wrap(p.x, width),
        z: wrap(p.z, width),
      };
    }
  }
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
      const dxA = wrappedDelta(a.x, b.x, width);
      const flipped = Math.abs(a.x - b.x) > width / 2;
      const bz = flipped ? -b.z : b.z;
      const dzA = wrappedDelta(a.z, bz, width);
      return Math.hypot(dxA, dzA);
    }
    case 'sphere': {
      // First-cut sphere distance mirrors the wrap: torus-like shortest path
      // across both axes.
      // TODO: proper sphere geodesic distance across cube faces.
      const dx = wrappedDelta(a.x, b.x, width);
      const dz = wrappedDelta(a.z, b.z, width);
      return Math.hypot(dx, dz);
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
export function wrappedUnitDelta(from: Vec2, to: Vec2, topology: Topology, width: number): Vec2 {
  let dx: number;
  let dz: number;
  switch (topology) {
    case 'plane': {
      dx = to.x - from.x;
      dz = to.z - from.z;
      break;
    }
    case 'torus':
    case 'sphere': {
      dx = wrappedDelta(from.x, to.x, width);
      dz = wrappedDelta(from.z, to.z, width);
      break;
    }
    case 'klein': {
      dx = wrappedDelta(from.x, to.x, width);
      const flipped = Math.abs(to.x - from.x) > width / 2;
      const tz = flipped ? -to.z : to.z;
      dz = wrappedDelta(from.z, tz, width);
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
