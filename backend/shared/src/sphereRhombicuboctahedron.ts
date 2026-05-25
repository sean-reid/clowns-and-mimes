// Sphere as a rhombicuboctahedron unfolded into a planar net.
//
// A rhombicuboctahedron has 26 faces: 18 squares + 8 triangles, with each
// vertex touching 1 triangle + 3 squares. Compared to a cube the squares
// are SEPARATED by triangles, which means the cube's ambiguous "three
// faces meet at a point" corner singularities never appear. Triangles act
// as solid barriers in our playfield, so a player walking diagonally
// toward a cube-corner spot is physically stopped before reaching the
// ambiguous region; they always pass through exactly one well-defined
// edge square between any pair of cube faces.
//
// The 18 squares decompose into:
//   - 6 "axial" squares (one per cube face: +X, -X, +Y, -Y, +Z, -Z)
//   - 12 "edge" squares (one per cube edge, sitting between two axials)
//
// Planar unfolding (8 columns x 7 rows):
//
//            col=0 col=1 col=2 col=3 col=4 col=5 col=6 col=7
//   row=0     .    T     ePYn  T     .     .     .     .
//   row=1     .    ePYw  +Y    ePYe  .     .     .     .
//   row=2     .    T     ePZn  T     .     .     .     .  (cap-to-eq link)
//   row=3    -X    eN    +Z    eS    +X    eR    -Z    eL  (equator belt)
//   row=4     .    T     eNYn  T     .     .     .     .  (cap-to-eq link)
//   row=5     .    eNYw  -Y    eNYe  .     .     .     .
//   row=6     .    T     eNYs  T     .     .     .     .
//
// `T` = triangle barrier (not walkable). The cap arms are 3 cols wide,
// centered on +Z's column (col=2). The horizontal equator belt is 8 cols
// of alternating axial / edge-square cells.
//
// Cap-to-cap connectivity at the outer net boundary (top of row 0,
// bottom of row 6, far edges of the equator beyond col=7 or col<0)
// happens via the polyhedron's edge graph: each outer net edge identifies
// to another edge somewhere else on the unfold, with a rotation. The
// non-trivial identifications are listed in the adjacency table below.

export const NET_COLS = 8;
export const NET_ROWS = 7;

/**
 * Cell kinds in the planar net. `axial` and `edge` are walkable squares.
 * `triangle` is a barrier. `void` is empty space outside the net (no
 * floor, no walls; the player can't reach it because the surrounding
 * cells are either triangles or off-playfield).
 */
export type CellKind = 'axial' | 'edge' | 'triangle' | 'void';

/**
 * Face identifier. Axial squares are named by their cube face normal
 * (+X, -X, +Y, -Y, +Z, -Z). Edge squares are named by the cube edge they
 * straddle: e.g., 'e+Z+X' is the square between +Z and +X on the equator.
 * Cap edge squares are 'ePYn' (+Y face, north edge), 'ePYe', 'ePYs',
 * 'ePYw', 'eNYn', 'eNYe', 'eNYs', 'eNYw'. Triangles are 't+x+y+z' etc.,
 * one per cube vertex.
 */
export type FaceId = string;

export const AXIAL_FACES: FaceId[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

// Cap edge squares connecting each pole axial (+Y, -Y) to the four equator
// axial faces.
export const CAP_EDGE_FACES: FaceId[] = [
  'ePYn',
  'ePYe',
  'ePYs',
  'ePYw',
  'eNYn',
  'eNYe',
  'eNYs',
  'eNYw',
];

// Equator edge squares between the four equator axials. Order matches the
// equator belt walking east: -X -> eN -> +Z -> eS -> +X -> eR -> -Z -> eL
// (then eL wraps to -X via the outer net seam).
export const EQUATOR_EDGE_FACES: FaceId[] = ['eN', 'eS', 'eR', 'eL'];

// Eight triangles, one per cube vertex. Named t<X-sign><Y-sign><Z-sign>.
export const TRIANGLE_FACES: FaceId[] = [
  't+x+y+z',
  't+x+y-z',
  't+x-y+z',
  't+x-y-z',
  't-x+y+z',
  't-x+y-z',
  't-x-y+z',
  't-x-y-z',
];

/**
 * (col, row) slot of each face in the planar net. Faces not listed are
 * void cells (no floor, never entered). Order of the keys is the
 * walk-order convention used by the maze generator so the GDScript mirror
 * stays deterministic.
 */
export const FACE_SLOTS: Record<FaceId, { col: number; row: number }> = {
  // Top cap (centered on col=2)
  't-x+y-z': { col: 1, row: 0 },
  ePYn: { col: 2, row: 0 },
  't+x+y-z': { col: 3, row: 0 },
  ePYw: { col: 1, row: 1 },
  '+Y': { col: 2, row: 1 },
  ePYe: { col: 3, row: 1 },
  't-x+y+z': { col: 1, row: 2 },
  ePYs: { col: 2, row: 2 },
  't+x+y+z': { col: 3, row: 2 },
  // Equator belt
  '-X': { col: 0, row: 3 },
  eN: { col: 1, row: 3 },
  '+Z': { col: 2, row: 3 },
  eS: { col: 3, row: 3 },
  '+X': { col: 4, row: 3 },
  eR: { col: 5, row: 3 },
  '-Z': { col: 6, row: 3 },
  eL: { col: 7, row: 3 },
  // Bottom cap (centered on col=2)
  't-x-y+z': { col: 1, row: 4 },
  eNYn: { col: 2, row: 4 },
  't+x-y+z': { col: 3, row: 4 },
  eNYw: { col: 1, row: 5 },
  '-Y': { col: 2, row: 5 },
  eNYe: { col: 3, row: 5 },
  't-x-y-z': { col: 1, row: 6 },
  eNYs: { col: 2, row: 6 },
  't+x-y-z': { col: 3, row: 6 },
};

/**
 * Kind lookup for each face in FACE_SLOTS. Faces not in FACE_SLOTS are
 * void cells and not listed here.
 */
const AXIAL_SET = new Set<FaceId>(AXIAL_FACES);

export function faceKind(face: FaceId): CellKind {
  if (AXIAL_SET.has(face)) return 'axial';
  if (face.startsWith('t')) return 'triangle';
  return 'edge';
}

/**
 * Walkable face check used by collision and maze generation.
 */
export function isWalkable(face: FaceId): boolean {
  const k = faceKind(face);
  return k === 'axial' || k === 'edge';
}

/**
 * The four cardinal edges of a square face in the net.
 */
export type Edge = 'east' | 'north' | 'west' | 'south';

/**
 * Identification rule for a step crossing `fromFace`'s `fromEdge`. The
 * rule names the destination face and which of its edges receives the
 * step, plus a `rotation` that controls how the edge parameter maps and
 * (indirectly) how face-local bases relate. Convention: when `rotation`
 * is 1 or 3 the parameter `t` along the departing edge maps to `1 - t`
 * on the receiving edge; for 0 or 2 it maps to `t`.
 *
 * Most edges in the rhombicuboctahedron net are grid-adjacent in the
 * unfold; those carry rotation 0 because the two cells sit side by side
 * with matching basis. The off-net identifications (eL.east<->-X.west,
 * plus six cap-edge wrap rules) carry the rotation derived from the
 * polyhedron's 3D corner mapping; round trips sum to 0 mod 4.
 */
export interface EdgeAdjacency {
  toFace: FaceId;
  toEdge: Edge;
  rotation: 0 | 1 | 2 | 3;
}

/**
 * Walkable-to-walkable edge adjacency for the full unfold. Edges that
 * lead to a triangle (barrier) or fully off-net are omitted; collision
 * stops the player at the wall before the crossing logic runs.
 */
export const ADJACENCY: Partial<Record<FaceId, Partial<Record<Edge, EdgeAdjacency>>>> = {
  // Axial faces.
  '+X': {
    east: { toFace: 'eR', toEdge: 'west', rotation: 0 },
    west: { toFace: 'eS', toEdge: 'east', rotation: 0 },
    north: { toFace: 'ePYe', toEdge: 'east', rotation: 0 },
    south: { toFace: 'eNYe', toEdge: 'east', rotation: 3 },
  },
  '-X': {
    east: { toFace: 'eN', toEdge: 'west', rotation: 0 },
    west: { toFace: 'eL', toEdge: 'east', rotation: 0 },
    north: { toFace: 'ePYw', toEdge: 'west', rotation: 3 },
    south: { toFace: 'eNYw', toEdge: 'west', rotation: 0 },
  },
  '+Z': {
    east: { toFace: 'eS', toEdge: 'west', rotation: 0 },
    west: { toFace: 'eN', toEdge: 'east', rotation: 0 },
    north: { toFace: 'ePYs', toEdge: 'south', rotation: 0 },
    south: { toFace: 'eNYn', toEdge: 'north', rotation: 0 },
  },
  '-Z': {
    east: { toFace: 'eL', toEdge: 'west', rotation: 0 },
    west: { toFace: 'eR', toEdge: 'east', rotation: 0 },
    north: { toFace: 'ePYn', toEdge: 'north', rotation: 3 },
    south: { toFace: 'eNYs', toEdge: 'south', rotation: 3 },
  },
  '+Y': {
    east: { toFace: 'ePYe', toEdge: 'west', rotation: 0 },
    west: { toFace: 'ePYw', toEdge: 'east', rotation: 0 },
    north: { toFace: 'ePYn', toEdge: 'south', rotation: 0 },
    south: { toFace: 'ePYs', toEdge: 'north', rotation: 0 },
  },
  '-Y': {
    east: { toFace: 'eNYe', toEdge: 'west', rotation: 0 },
    west: { toFace: 'eNYw', toEdge: 'east', rotation: 0 },
    north: { toFace: 'eNYn', toEdge: 'south', rotation: 0 },
    south: { toFace: 'eNYs', toEdge: 'north', rotation: 0 },
  },
  // Top cap edge squares.
  ePYn: {
    south: { toFace: '+Y', toEdge: 'north', rotation: 0 },
    north: { toFace: '-Z', toEdge: 'north', rotation: 1 },
  },
  ePYe: {
    west: { toFace: '+Y', toEdge: 'east', rotation: 0 },
    east: { toFace: '+X', toEdge: 'north', rotation: 0 },
  },
  ePYw: {
    east: { toFace: '+Y', toEdge: 'west', rotation: 0 },
    west: { toFace: '-X', toEdge: 'north', rotation: 1 },
  },
  ePYs: {
    north: { toFace: '+Y', toEdge: 'south', rotation: 0 },
    south: { toFace: '+Z', toEdge: 'north', rotation: 0 },
  },
  // Bottom cap edge squares.
  eNYn: {
    north: { toFace: '+Z', toEdge: 'south', rotation: 0 },
    south: { toFace: '-Y', toEdge: 'north', rotation: 0 },
  },
  eNYe: {
    west: { toFace: '-Y', toEdge: 'east', rotation: 0 },
    east: { toFace: '+X', toEdge: 'south', rotation: 1 },
  },
  eNYw: {
    east: { toFace: '-Y', toEdge: 'west', rotation: 0 },
    west: { toFace: '-X', toEdge: 'south', rotation: 0 },
  },
  eNYs: {
    north: { toFace: '-Y', toEdge: 'south', rotation: 0 },
    south: { toFace: '-Z', toEdge: 'south', rotation: 1 },
  },
  // Equator edge squares.
  eN: {
    east: { toFace: '+Z', toEdge: 'west', rotation: 0 },
    west: { toFace: '-X', toEdge: 'east', rotation: 0 },
  },
  eS: {
    east: { toFace: '+X', toEdge: 'west', rotation: 0 },
    west: { toFace: '+Z', toEdge: 'east', rotation: 0 },
  },
  eR: {
    east: { toFace: '-Z', toEdge: 'west', rotation: 0 },
    west: { toFace: '+X', toEdge: 'east', rotation: 0 },
  },
  eL: {
    east: { toFace: '-X', toEdge: 'west', rotation: 0 },
    west: { toFace: '-Z', toEdge: 'east', rotation: 0 },
  },
};

/**
 * For a (col, row) slot, look up which face occupies it. Returns null
 * for void cells.
 */
export function faceAtSlot(col: number, row: number): FaceId | null {
  for (const [face, slot] of Object.entries(FACE_SLOTS)) {
    if (slot.col === col && slot.row === row) return face;
  }
  return null;
}

/**
 * Inverse of FACE_SLOTS: face -> (col, row).
 */
export function slotOf(face: FaceId): { col: number; row: number } {
  const s = FACE_SLOTS[face];
  if (!s) throw new Error(`unknown face: ${face}`);
  return s;
}

/**
 * Playfield extents in world units for a face of side `faceSide`. The
 * unfold is NET_COLS wide and NET_ROWS tall.
 */
export function spherePlayfieldExtents(faceSide: number): { x: number; z: number } {
  return { x: NET_COLS * faceSide, z: NET_ROWS * faceSide };
}

function slotXRange(col: number, faceSide: number): { min: number; max: number } {
  const halfX = (NET_COLS * faceSide) / 2;
  return { min: col * faceSide - halfX, max: (col + 1) * faceSide - halfX };
}

function slotZRange(row: number, faceSide: number): { min: number; max: number } {
  const halfZ = (NET_ROWS * faceSide) / 2;
  const zMax = halfZ - row * faceSide;
  return { min: zMax - faceSide, max: zMax };
}

/**
 * World region occupied by `face`. Inputs use `faceSide`, the side length
 * of one square cell in the unfold. The playfield is centered at the
 * origin. Throws if called on a face that has no slot.
 */
export function faceWorldRect(
  face: FaceId,
  faceSide: number,
): { xMin: number; xMax: number; zMin: number; zMax: number } {
  const slot = FACE_SLOTS[face];
  if (!slot) throw new Error(`unknown face: ${face}`);
  const xr = slotXRange(slot.col, faceSide);
  const zr = slotZRange(slot.row, faceSide);
  return { xMin: xr.min, xMax: xr.max, zMin: zr.min, zMax: zr.max };
}

/**
 * Walkable face containing world point (x, z), or null when the point
 * falls on a triangle barrier or a void cell.
 */
export function worldToFace(x: number, z: number, faceSide: number): FaceId | null {
  for (const face of Object.keys(FACE_SLOTS)) {
    if (!isWalkable(face)) continue;
    const r = faceWorldRect(face, faceSide);
    if (x >= r.xMin && x < r.xMax && z >= r.zMin && z < r.zMax) {
      return face;
    }
  }
  return null;
}

/**
 * Face-local (u, v) in [0, 1] for a world point inside `face`. u grows
 * east (+x), v grows north (+z).
 */
export function worldToFaceLocal(
  face: FaceId,
  x: number,
  z: number,
  faceSide: number,
): { u: number; v: number } {
  const r = faceWorldRect(face, faceSide);
  return { u: (x - r.xMin) / faceSide, v: (z - r.zMin) / faceSide };
}

/**
 * Inverse of worldToFaceLocal.
 */
export function faceLocalToWorld(
  face: FaceId,
  u: number,
  v: number,
  faceSide: number,
): { x: number; z: number } {
  const r = faceWorldRect(face, faceSide);
  return { x: r.xMin + u * faceSide, z: r.zMin + v * faceSide };
}

/**
 * 90-degree-step rotation in the face-local unit square. Provided for
 * callers that need to transform an interior point during a basis swap.
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
 * Cross `fromFace` through `fromEdge`, given the parameter `t` along the
 * edge in [0, 1]. Returns the destination face-local point, with the
 * receiving edge's coordinate pinned to 0 or 1 and the parameter mapped
 * by the adjacency rule. Returns null when the edge has no walkable
 * adjacency (caller should treat the crossing as blocked by a wall).
 */
export function crossEdge(
  fromFace: FaceId,
  fromEdge: Edge,
  t: number,
): { face: FaceId; u: number; v: number } | null {
  const adj = ADJACENCY[fromFace]?.[fromEdge];
  if (!adj) return null;
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

/**
 * Step from `prev` to `next` (world coords). If the step stays on the
 * same face, returns `next` unchanged. If it crosses a face boundary,
 * routes through `crossEdge` and returns the equivalent destination,
 * nudged slightly inward off the receiving edge so the next tick sits
 * unambiguously inside the destination face.
 *
 * If `prev` is not on a walkable face, returns `next` (caller's collision
 * logic handles the rest). If the crossing has no walkable adjacency,
 * returns `prev` so the player stays put (wall hit).
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
  const rect = faceWorldRect(fromFace, faceSide);
  const dx = next.x - prev.x;
  const dz = next.z - prev.z;
  const pastEast = next.x - rect.xMax;
  const pastWest = rect.xMin - next.x;
  const pastNorth = next.z - rect.zMax;
  const pastSouth = rect.zMin - next.z;
  const allExits: Array<{ edge: Edge; past: number; weight: number }> = [
    { edge: 'east', past: pastEast, weight: dx },
    { edge: 'west', past: pastWest, weight: -dx },
    { edge: 'north', past: pastNorth, weight: dz },
    { edge: 'south', past: pastSouth, weight: -dz },
  ];
  const exits = allExits.filter((e) => e.past > 0);
  if (exits.length === 0) return next;
  exits.sort((a, b) => b.past - a.past || b.weight - a.weight);
  const edge = exits[0]!.edge;
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
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dest = crossEdge(fromFace, edge, t);
  if (dest === null) return prev;
  const overshoot = exits[0]!.past;
  const inwardLocal = Math.min(overshoot / faceSide, 0.999);
  let u = dest.u;
  let v = dest.v;
  if (u === 0) u = inwardLocal;
  else if (u === 1) u = 1 - inwardLocal;
  else if (v === 0) v = inwardLocal;
  else if (v === 1) v = 1 - inwardLocal;
  return faceLocalToWorld(dest.face, u, v, faceSide);
}
