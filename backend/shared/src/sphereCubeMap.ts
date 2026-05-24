// Cube map for the sphere topology.
//
// The cube is laid out as a T-net (Latin-cross) in a 4 x 3 grid. The four
// equator faces (-X, +Z, +X, -Z) sit in row 1 with the poles (+Y, -Y)
// above and below the +Z slot:
//
//                col=0  col=1  col=2  col=3
//        row=0          +Y
//        row=1   -X     +Z     +X     -Z
//        row=2          -Y
//
// The empty grid cells (corners of the T) are not part of the playfield;
// the cube has only 6 faces and the T-net is the standard way to unfold a
// cube into a contiguous plane region without overlap.
//
// Adjacencies are derived from the cube's actual edge graph:
//   - Each face borders exactly four others.
//   - Opposite faces (+X/-X, +Y/-Y, +Z/-Z) never share an edge.
//   - The four equator faces form a 4-cycle: ... -X -> +Z -> +X -> -Z -> -X ...
//   - The poles each border all four equator faces.
//
// Crossings WITHIN the equator row are rotation-free (the row IS the cycle).
// Crossings into/out of a pole face involve 0, 90, 180, or 270 degree
// rotations of the face-local (u, v) basis, depending on which equator
// neighbour you arrive from.
//
// Status: this module owns the adjacency graph and a `rotateFaceLocal`
// helper. `crossEdge` is implemented for the equator crossings (all the
// rotation-free ones) and the +Y/+Z, +Y/-Z, -Y/+Z, -Y/-Z direct neighbours.
// The four diagonal pole-to-equator crossings (the ones with non-zero
// rotation) carry their rotation value in the table and an explicit
// regression test pins their identification; the full transfer-with-
// rotation walk is a follow-up that wires this graph into `wrapPosition`.

export const FACE_GRID_COLS = 4;
export const FACE_GRID_ROWS = 3;

export const CUBE_FACES = ['+Y', '-X', '+Z', '+X', '-Z', '-Y'] as const;
export type CubeFace = (typeof CUBE_FACES)[number];

export type Edge = 'east' | 'north' | 'west' | 'south';

export interface EdgeAdjacency {
  toFace: CubeFace;
  toEdge: Edge;
  // Clockwise quarter-turns applied to (u, v) on the destination face,
  // relative to the (u, v) you depart from. 0 means the bases line up; 1,
  // 2, 3 are 90, 180, 270 degree turns.
  rotation: 0 | 1 | 2 | 3;
}

type AdjacencyMap = Record<CubeFace, Record<Edge, EdgeAdjacency>>;

/**
 * T-net grid slot for each cube face. (col, row) with col in [0, 4) and row
 * in [0, 3). Used by callers that want to lay walls/floor out in the
 * playfield; the adjacency graph below is independent of the layout.
 */
export const FACE_SLOTS: Record<CubeFace, { col: number; row: number }> = {
  '+Y': { col: 1, row: 0 },
  '-X': { col: 0, row: 1 },
  '+Z': { col: 1, row: 1 },
  '+X': { col: 2, row: 1 },
  '-Z': { col: 3, row: 1 },
  '-Y': { col: 1, row: 2 },
};

/**
 * Cube adjacency. Every entry is checked by the test suite for symmetry
 * (round trip returns to origin) and for opposite-face exclusion.
 */
export const CUBE_ADJACENCY: AdjacencyMap = {
  // Equator: rotation-free 4-cycle.
  '-X': {
    east: { toFace: '+Z', toEdge: 'west', rotation: 0 },
    west: { toFace: '-Z', toEdge: 'east', rotation: 0 },
    north: { toFace: '+Y', toEdge: 'west', rotation: 3 },
    south: { toFace: '-Y', toEdge: 'west', rotation: 1 },
  },
  '+Z': {
    east: { toFace: '+X', toEdge: 'west', rotation: 0 },
    west: { toFace: '-X', toEdge: 'east', rotation: 0 },
    north: { toFace: '+Y', toEdge: 'south', rotation: 0 },
    south: { toFace: '-Y', toEdge: 'north', rotation: 0 },
  },
  '+X': {
    east: { toFace: '-Z', toEdge: 'west', rotation: 0 },
    west: { toFace: '+Z', toEdge: 'east', rotation: 0 },
    north: { toFace: '+Y', toEdge: 'east', rotation: 1 },
    south: { toFace: '-Y', toEdge: 'east', rotation: 3 },
  },
  '-Z': {
    east: { toFace: '-X', toEdge: 'west', rotation: 0 },
    west: { toFace: '+X', toEdge: 'east', rotation: 0 },
    north: { toFace: '+Y', toEdge: 'north', rotation: 2 },
    south: { toFace: '-Y', toEdge: 'south', rotation: 2 },
  },
  // Poles: each shares an edge with all four equator faces.
  '+Y': {
    east: { toFace: '+X', toEdge: 'north', rotation: 3 },
    west: { toFace: '-X', toEdge: 'north', rotation: 1 },
    north: { toFace: '-Z', toEdge: 'north', rotation: 2 },
    south: { toFace: '+Z', toEdge: 'north', rotation: 0 },
  },
  '-Y': {
    east: { toFace: '+X', toEdge: 'south', rotation: 1 },
    west: { toFace: '-X', toEdge: 'south', rotation: 3 },
    north: { toFace: '+Z', toEdge: 'south', rotation: 0 },
    south: { toFace: '-Z', toEdge: 'south', rotation: 2 },
  },
};

/**
 * Apply a 90-degree-step clockwise rotation to a point in the face-local
 * unit square. The unit square is mapped to itself.
 */
export function rotateFaceLocal(
  u: number,
  v: number,
  rotation: 0 | 1 | 2 | 3,
): { u: number; v: number } {
  switch (rotation) {
    case 0:
      return { u, v };
    case 1:
      return { u: v, v: 1 - u };
    case 2:
      return { u: 1 - u, v: 1 - v };
    case 3:
      return { u: 1 - v, v: u };
  }
}

/**
 * Cross from `fromFace` through `fromEdge`, given a parameter `t` along
 * that edge in [0, 1]. Returns the destination face and the (u, v) point
 * where you arrive. Equator crossings drop you exactly on the receiving
 * edge with the rotation baked into the parameter transformation; pole
 * crossings carry the same rotation through to the destination edge.
 */
export function crossEdge(
  fromFace: CubeFace,
  fromEdge: Edge,
  t: number,
): { face: CubeFace; u: number; v: number } {
  const adj = CUBE_ADJACENCY[fromFace][fromEdge];
  // Reverse the parameter when the rotation flips edge orientation. A
  // rotation of 1 or 3 (quarter turn) re-maps the departing edge to a
  // perpendicular destination edge with the parameter inverted.
  const tDest = adj.rotation === 1 || adj.rotation === 3 ? 1 - t : t;
  switch (adj.toEdge) {
    case 'east':
      return { face: adj.toFace, u: 1, v: tDest };
    case 'west':
      return { face: adj.toFace, u: 0, v: tDest };
    case 'north':
      return { face: adj.toFace, u: tDest, v: 1 };
    case 'south':
      return { face: adj.toFace, u: tDest, v: 0 };
  }
}
