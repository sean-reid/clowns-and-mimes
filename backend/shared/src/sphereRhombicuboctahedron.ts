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
 * Identification rule when a step crosses `fromFace`'s `fromEdge` and
 * lands on a void cell or runs off the net. The rule names the
 * destination face and which of its edges receives the step, plus the
 * basis rotation (clockwise quarter turns of (u, v) on the destination).
 *
 * Most identifications are around the outer rim of the net (where the
 * equator wraps east-west, and the cap arms wrap to other cap arms via
 * the polyhedron's edge graph). The internal "grid-adjacent" crossings -
 * e.g., axial to its neighbour edge square in the same row or column -
 * need no identification because the player just walks across the
 * boundary into the next walkable cell.
 *
 * Status: this PR defines the adjacency for the equator wrap edges
 * (east of eL -> west of -X and vice versa) which is the simplest
 * non-grid-adjacent case. The 8 cap-edge identifications (north / south
 * of the cap arms wrapping to other equator axials' north / south)
 * follow the polyhedron's edge graph and are filled in by the follow-up
 * wire-up PR.
 */
export interface EdgeAdjacency {
  toFace: FaceId;
  toEdge: Edge;
  rotation: 0 | 1 | 2 | 3;
}

// Equator east-west wrap. eL east -> -X west, no rotation; -X west ->
// eL east, no rotation. The equator is a flat 8-square belt; wrapping
// around its outer left/right edges is rotation-free because the polyhedron
// rolls smoothly along the equator without any face-basis twist.
export const EQUATOR_WRAP: Partial<Record<FaceId, Partial<Record<Edge, EdgeAdjacency>>>> = {
  eL: {
    east: { toFace: '-X', toEdge: 'west', rotation: 0 },
  },
  '-X': {
    west: { toFace: 'eL', toEdge: 'east', rotation: 0 },
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
