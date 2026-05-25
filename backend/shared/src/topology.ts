import type { Topology, Vec2 } from './protocol.ts';
import { genus2Extents, stepAcrossGenus2Boundary, wrapGenus2Point } from './genus2.ts';
import {
  MOBIUS_HALF_X,
  mobiusExtents,
  stepAcrossMobiusBoundary,
  wrapMobiusPoint,
} from './mobius.ts';

export const WORLD_WIDTH = 80;

/**
 * Per-topology playfield extents in world units. Klein doubles x for its
 * z-mirrored second half. Genus2 uses the octagon's bounding box (square
 * around the polygon with circumradius set in genus2.ts). Plane and torus
 * are plain WxW squares.
 */
export function topologyExtents(topology: Topology, width: number): { x: number; z: number } {
  if (topology === 'klein') return { x: 2 * width, z: width };
  if (topology === 'genus2') {
    void width;
    return genus2Extents();
  }
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
    case 'genus2': {
      // Recovery wrap: a point inside the octagon passes through. A point
      // outside (shouldn't happen in normal play, but spawn / reconcile
      // can land off-polygon) gets identified through its crossing side.
      void width;
      return wrapGenus2Point(p);
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
 * Step-aware wrap. When motion takes the player from `prev` to `candidate`
 * on the genus-2 surface, route the position through the octagon
 * identification so a seam crossing lands on the mate side. All other
 * topologies ignore `prev` and behave the same as `wrapPosition`.
 */
export function wrapPositionFromStep(
  prev: Vec2,
  candidate: Vec2,
  topology: Topology,
  width: number,
): Vec2 {
  if (topology === 'genus2') {
    return stepAcrossGenus2Boundary(prev, candidate);
  }
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
    case 'genus2': {
      // Octagon distance is Euclidean inside the polygon. Cross-boundary
      // shortest paths are not yet implemented; sub-octagon queries are
      // exact and bot vision / tag radius only ever look at small ranges.
      void width;
      return Math.hypot(a.x - b.x, a.z - b.z);
    }
    case 'mobius': {
      // Möbius distance: take the shorter of the direct chord and the
      // wrap-with-z-flip chord. The wrap candidate translates the source
      // by +/- 2*MOBIUS_HALF_X in x and flips z, then measures straight-
      // line distance to b. This matches the actual shortest path on
      // the flat universal cover.
      void width;
      const direct = Math.hypot(a.x - b.x, a.z - b.z);
      const wrapRight = Math.hypot(a.x + 2 * MOBIUS_HALF_X - b.x, -a.z - b.z);
      const wrapLeft = Math.hypot(a.x - 2 * MOBIUS_HALF_X - b.x, -a.z - b.z);
      return Math.min(direct, wrapRight, wrapLeft);
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
    case 'genus2': {
      // Octagon: short-range directions use plain Euclidean. Identification
      // crossings would need shortest-path solving across mate sides; the
      // gameplay loop only queries this for chase / flee headings within a
      // small radius, so the approximation is fine.
      dx = to.x - from.x;
      dz = to.z - from.z;
      break;
    }
    case 'mobius': {
      // Pick the shorter of the direct or x-wrap-with-z-flip path so a
      // bot near the seam heads through it instead of taking the long
      // way around. The wrap deltas mirror the topologyDistance path.
      void width;
      const direct = { dx: to.x - from.x, dz: to.z - from.z, dist: 0 };
      direct.dist = Math.hypot(direct.dx, direct.dz);
      const wrapR = {
        dx: to.x - (from.x + 2 * MOBIUS_HALF_X),
        dz: -to.z - from.z,
        dist: 0,
      };
      wrapR.dist = Math.hypot(wrapR.dx, wrapR.dz);
      const wrapL = {
        dx: to.x - (from.x - 2 * MOBIUS_HALF_X),
        dz: -to.z - from.z,
        dist: 0,
      };
      wrapL.dist = Math.hypot(wrapL.dx, wrapL.dz);
      const best =
        direct.dist <= Math.min(wrapR.dist, wrapL.dist)
          ? direct
          : wrapR.dist <= wrapL.dist
            ? wrapR
            : wrapL;
      dx = best.dx;
      dz = best.dz;
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
