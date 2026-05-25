import type { Topology, Vec2 } from './protocol.ts';
import {
  FACE_SLOTS,
  NET_COLS,
  faceWorldRect,
  isWalkable,
  spherePlayfieldExtents,
  stepAcrossSphereFaces,
  worldToFace,
  type FaceId,
} from './sphereRhombicuboctahedron.ts';

export const WORLD_WIDTH = 80;

/**
 * Side length of one square cell in the rhombicuboctahedron unfold. The
 * net is 8 cols x 7 rows of cells, so face = WORLD_WIDTH / 8 keeps the
 * x-extent at exactly WORLD_WIDTH and the z-extent at 7/8 * WORLD_WIDTH.
 */
export const SPHERE_FACE_SIDE = WORLD_WIDTH / NET_COLS;

/**
 * Per-topology playfield extents in world units. Klein and sphere are both
 * non-square. Klein doubles x for its z-mirrored second half; sphere shrinks
 * z to 3/4 of WORLD_WIDTH so the T-net's 4 x 3 face grid sits at unit aspect
 * per face.
 */
export function topologyExtents(topology: Topology, width: number): { x: number; z: number } {
  if (topology === 'klein') return { x: 2 * width, z: width };
  if (topology === 'sphere') {
    const faceSide = width / NET_COLS;
    return spherePlayfieldExtents(faceSide);
  }
  return { x: width, z: width };
}

/**
 * Walkable faces of the sphere unfold, computed once. Used by the
 * wrapPosition snap-to-face-center recovery path.
 */
const WALKABLE_FACES: FaceId[] = Object.keys(FACE_SLOTS).filter(isWalkable);

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
    case 'sphere': {
      // Single-point sphere wrap is a recovery path: a step that lands on a
      // walkable face just passes through. For genuine motion crossings the
      // caller should use `wrapPositionFromStep(prev, candidate, ...)` so
      // edge identification + rotation are applied. The pure-point clamp
      // keeps spawn / initial state on a walkable face.
      const faceSide = width / NET_COLS;
      const face = worldToFace(p.x, p.z, faceSide);
      if (face !== null) return p;
      // Fell into a triangle barrier or net void: snap to the nearest
      // walkable face center as a best-effort recovery. Should not happen
      // in normal play.
      let bestFace: FaceId = WALKABLE_FACES[0]!;
      let bestDist = Infinity;
      for (const f of WALKABLE_FACES) {
        const r = faceWorldRect(f, faceSide);
        const cx = (r.xMin + r.xMax) / 2;
        const cz = (r.zMin + r.zMax) / 2;
        const d = Math.hypot(p.x - cx, p.z - cz);
        if (d < bestDist) {
          bestDist = d;
          bestFace = f;
        }
      }
      const r = faceWorldRect(bestFace, faceSide);
      return { x: (r.xMin + r.xMax) / 2, z: (r.zMin + r.zMax) / 2 };
    }
  }
}

/**
 * Step-aware wrap. When motion takes the player from `prev` to `candidate`
 * on the sphere, route the position through cube adjacency so an edge
 * crossing lands on the correct face (with the rotation baked in). All
 * other topologies ignore `prev` and behave the same as `wrapPosition`.
 */
export function wrapPositionFromStep(
  prev: Vec2,
  candidate: Vec2,
  topology: Topology,
  width: number,
): Vec2 {
  if (topology !== 'sphere') return wrapPosition(candidate, topology, width);
  const faceSide = width / NET_COLS;
  return stepAcrossSphereFaces(prev, candidate, faceSide);
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
    case 'sphere': {
      // Sphere distance on the T-net is the Euclidean distance in the
      // unfolded playfield. Short steps inside a face are exact; longer
      // distances are approximate because they cross faces in a straight
      // line on the unfold instead of via the geodesic on the cube. The
      // approximation is fine for bot vision and tag radius, which only
      // ever look at sub-face distances.
      // TODO: cube-geodesic distance for long-range queries.
      return Math.hypot(a.x - b.x, a.z - b.z);
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
    case 'sphere': {
      // T-net unfold: short steps use plain Euclidean direction. See
      // topologyDistance comment for the approximation rationale.
      dx = to.x - from.x;
      dz = to.z - from.z;
      break;
    }
    case 'klein': {
      dx = wrappedDelta(from.x, to.x, 2 * width);
      dz = wrappedDelta(from.z, to.z, width);
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
