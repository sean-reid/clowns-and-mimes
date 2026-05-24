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
 * Sphere playfield extents in world units when a face has side `faceSide`.
 * T-net is 4 cols * 3 rows, so the playfield is 4*faceSide wide and
 * 3*faceSide tall. Use this to keep extent_x / extent_z consistent across
 * the math and rendering layers.
 */
export function spherePlayfieldExtents(faceSide: number): { x: number; z: number } {
  return { x: FACE_GRID_COLS * faceSide, z: FACE_GRID_ROWS * faceSide };
}

/**
 * World x-range of a slot's column. The playfield is centered at the
 * origin, so the leftmost column starts at -extent_x/2.
 */
function slotXRange(col: number, faceSide: number): { min: number; max: number } {
  const halfX = (FACE_GRID_COLS * faceSide) / 2;
  return { min: col * faceSide - halfX, max: (col + 1) * faceSide - halfX };
}

/**
 * World z-range of a slot's row. row=0 is the highest z (top of the
 * playfield in a top-down view), row=2 is the lowest.
 */
function slotZRange(row: number, faceSide: number): { min: number; max: number } {
  const halfZ = (FACE_GRID_ROWS * faceSide) / 2;
  const zMax = halfZ - row * faceSide;
  return { min: zMax - faceSide, max: zMax };
}

/**
 * World region a given face occupies in the T-net playfield. Inputs use
 * `faceSide`, the side length of each cube face in world units.
 */
export function faceWorldRect(
  face: CubeFace,
  faceSide: number,
): { xMin: number; xMax: number; zMin: number; zMax: number } {
  const slot = FACE_SLOTS[face];
  const xr = slotXRange(slot.col, faceSide);
  const zr = slotZRange(slot.row, faceSide);
  return { xMin: xr.min, xMax: xr.max, zMin: zr.min, zMax: zr.max };
}

/**
 * Which face contains world point (x, z), or null if the point falls into
 * one of the six T-net void cells. (col=0,2,3 of row 0) and (col=0,2,3 of
 * row 2) are voids; the remaining six (col, row) slots are face territory.
 */
export function worldToFace(x: number, z: number, faceSide: number): CubeFace | null {
  for (const face of CUBE_FACES) {
    const r = faceWorldRect(face, faceSide);
    if (x >= r.xMin && x < r.xMax && z >= r.zMin && z < r.zMax) {
      return face;
    }
  }
  return null;
}

/**
 * Convert a world point that lies inside `face` into face-local (u, v) in
 * [0, 1]. u grows east (+x); v grows north (+z). Caller is responsible for
 * passing a point that is actually inside `face`.
 */
export function worldToFaceLocal(
  face: CubeFace,
  x: number,
  z: number,
  faceSide: number,
): { u: number; v: number } {
  const r = faceWorldRect(face, faceSide);
  return { u: (x - r.xMin) / faceSide, v: (z - r.zMin) / faceSide };
}

/**
 * Inverse of worldToFaceLocal: convert face-local (u, v) on `face` back
 * into world coordinates.
 */
export function faceLocalToWorld(
  face: CubeFace,
  u: number,
  v: number,
  faceSide: number,
): { x: number; z: number } {
  const r = faceWorldRect(face, faceSide);
  return { x: r.xMin + u * faceSide, z: r.zMin + v * faceSide };
}

/**
 * Given a step on the sphere from `prev` to `next` (in world coords), if
 * the step crosses a face edge, apply cube adjacency to find the
 * equivalent destination. Returns the destination world position. When
 * `prev` and `next` are on the same face, returns `next` unchanged.
 *
 * Edge cases: if `prev` is in a void cell (shouldn't happen in normal
 * play), returns `next` unchanged so the caller's wall / collision logic
 * sees the original position. If `next` is out of bounds in a direction
 * other than the four cardinal edges of `prev`'s face, the closest cardinal
 * edge is picked.
 */
export function stepAcrossSphereFaces(
  prev: { x: number; z: number },
  next: { x: number; z: number },
  faceSide: number,
): { x: number; z: number } {
  const fromFace = worldToFace(prev.x, prev.z, faceSide);
  if (fromFace === null) return next;
  const toFace = worldToFace(next.x, next.z, faceSide);
  if (toFace === fromFace) return next;
  // Step left the face. Decide which edge it crossed by comparing motion
  // direction with the face's world rect. For ambiguous corner crossings
  // (off two edges at once), prefer the dominant motion axis.
  const rect = faceWorldRect(fromFace, faceSide);
  const dx = next.x - prev.x;
  const dz = next.z - prev.z;
  let edge: Edge;
  // Distance past each edge - whichever is positive is the side we exited.
  const pastEast = next.x - rect.xMax;
  const pastWest = rect.xMin - next.x;
  const pastNorth = next.z - rect.zMax;
  const pastSouth = rect.zMin - next.z;
  // Pick the dominant exit: the largest "past" value, tiebreak on motion
  // direction so a diagonal step into a corner snaps to the axis it moved
  // most in.
  const allExits: Array<{ edge: Edge; past: number; weight: number }> = [
    { edge: 'east', past: pastEast, weight: dx },
    { edge: 'west', past: pastWest, weight: -dx },
    { edge: 'north', past: pastNorth, weight: dz },
    { edge: 'south', past: pastSouth, weight: -dz },
  ];
  const exits = allExits.filter((e) => e.past > 0);
  if (exits.length === 0) return next; // shouldn't happen if toFace !== fromFace
  exits.sort((a, b) => b.past - a.past || b.weight - a.weight);
  edge = exits[0]!.edge;
  // Parameter t along the departing edge.
  let t: number;
  switch (edge) {
    case 'east':
    case 'west':
      t = (next.z - rect.zMin) / faceSide;
      break;
    case 'north':
    case 'south':
      t = (next.x - rect.xMin) / faceSide;
      break;
  }
  // Clamp t for numerical safety.
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dest = crossEdge(fromFace, edge, t);
  // Nudge slightly inward from the destination edge so the next tick is
  // unambiguously inside `dest.face`. The nudge magnitude is the leftover
  // step beyond the departing edge, projected onto the new face's basis.
  const exitOvershoot = exits[0]!.past;
  // Convert overshoot to face-local units (overshoot is in world coords;
  // faceSide world units == 1 face-local unit on the destination face).
  const inwardLocal = Math.min(exitOvershoot / faceSide, 0.999);
  let u = dest.u;
  let v = dest.v;
  // Push inward off the receiving edge.
  switch (dest.face === dest.face ? destInwardAxis(dest.face, dest.u, dest.v) : 'u') {
    case 'inward-u-pos':
      u = inwardLocal;
      break;
    case 'inward-u-neg':
      u = 1 - inwardLocal;
      break;
    case 'inward-v-pos':
      v = inwardLocal;
      break;
    case 'inward-v-neg':
      v = 1 - inwardLocal;
      break;
  }
  return faceLocalToWorld(dest.face, u, v, faceSide);
}

/**
 * The destination of crossEdge lands on the receiving edge with u or v
 * pegged at 0 or 1. Figure out which axis to push inward off to bring the
 * point into the face interior.
 */
function destInwardAxis(
  _face: CubeFace,
  u: number,
  v: number,
): 'inward-u-pos' | 'inward-u-neg' | 'inward-v-pos' | 'inward-v-neg' {
  if (u === 0) return 'inward-u-pos';
  if (u === 1) return 'inward-u-neg';
  if (v === 0) return 'inward-v-pos';
  return 'inward-v-neg';
}

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
