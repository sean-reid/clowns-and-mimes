import { describe, expect, it } from 'vitest';
import {
  AXIAL_FACES,
  CAP_EDGE_FACES,
  EQUATOR_EDGE_FACES,
  EQUATOR_WRAP,
  FACE_SLOTS,
  NET_COLS,
  NET_ROWS,
  TRIANGLE_FACES,
  faceAtSlot,
  faceKind,
  isWalkable,
  slotOf,
} from './sphereRhombicuboctahedron.ts';

describe('rhombicuboctahedron face counts', () => {
  it('has 6 axials, 12 edge squares (8 cap + 4 equator), 8 triangles', () => {
    expect(AXIAL_FACES.length).toBe(6);
    expect(CAP_EDGE_FACES.length).toBe(8);
    expect(EQUATOR_EDGE_FACES.length).toBe(4);
    expect(TRIANGLE_FACES.length).toBe(8);
  });

  it('FACE_SLOTS covers exactly the 26 polyhedron faces', () => {
    const expected =
      AXIAL_FACES.length +
      CAP_EDGE_FACES.length +
      EQUATOR_EDGE_FACES.length +
      TRIANGLE_FACES.length;
    expect(expected).toBe(26);
    expect(Object.keys(FACE_SLOTS).length).toBe(26);
  });
});

describe('planar net layout', () => {
  it('every slot fits inside the 8x7 grid with no duplicates', () => {
    const seen = new Set<string>();
    for (const [, slot] of Object.entries(FACE_SLOTS)) {
      expect(slot.col).toBeGreaterThanOrEqual(0);
      expect(slot.col).toBeLessThan(NET_COLS);
      expect(slot.row).toBeGreaterThanOrEqual(0);
      expect(slot.row).toBeLessThan(NET_ROWS);
      const key = `${slot.col},${slot.row}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('faceAtSlot and slotOf round-trip', () => {
    for (const [face] of Object.entries(FACE_SLOTS)) {
      const s = slotOf(face);
      expect(faceAtSlot(s.col, s.row)).toBe(face);
    }
  });

  it('void cells return null from faceAtSlot', () => {
    // Top-left corner of the playfield is outside the cap arm.
    expect(faceAtSlot(0, 0)).toBeNull();
    // Far right of row 2 (cap arm only covers col 1-3).
    expect(faceAtSlot(7, 2)).toBeNull();
  });
});

describe('faceKind', () => {
  it('classifies axials', () => {
    for (const f of AXIAL_FACES) expect(faceKind(f)).toBe('axial');
  });

  it('classifies edge squares', () => {
    for (const f of CAP_EDGE_FACES) expect(faceKind(f)).toBe('edge');
    for (const f of EQUATOR_EDGE_FACES) expect(faceKind(f)).toBe('edge');
  });

  it('classifies triangles', () => {
    for (const f of TRIANGLE_FACES) expect(faceKind(f)).toBe('triangle');
  });
});

describe('isWalkable', () => {
  it('returns true for axials and edge squares', () => {
    for (const f of AXIAL_FACES) expect(isWalkable(f)).toBe(true);
    for (const f of CAP_EDGE_FACES) expect(isWalkable(f)).toBe(true);
    for (const f of EQUATOR_EDGE_FACES) expect(isWalkable(f)).toBe(true);
  });

  it('returns false for triangles', () => {
    for (const f of TRIANGLE_FACES) expect(isWalkable(f)).toBe(false);
  });
});

describe('equator wrap', () => {
  it('eL east identifies to -X west, no rotation', () => {
    const a = EQUATOR_WRAP.eL?.east;
    expect(a).toBeDefined();
    expect(a?.toFace).toBe('-X');
    expect(a?.toEdge).toBe('west');
    expect(a?.rotation).toBe(0);
  });

  it('-X west identifies back to eL east, no rotation', () => {
    const a = EQUATOR_WRAP['-X']?.west;
    expect(a).toBeDefined();
    expect(a?.toFace).toBe('eL');
    expect(a?.toEdge).toBe('east');
    expect(a?.rotation).toBe(0);
  });
});

describe('equator belt grid layout', () => {
  it('alternates axial and edge squares left to right at row 3', () => {
    const expectedOrder: [number, string][] = [
      [0, '-X'],
      [1, 'eN'],
      [2, '+Z'],
      [3, 'eS'],
      [4, '+X'],
      [5, 'eR'],
      [6, '-Z'],
      [7, 'eL'],
    ];
    for (const [col, face] of expectedOrder) {
      expect(faceAtSlot(col, 3)).toBe(face);
    }
  });
});

describe('cap layout', () => {
  it('+Y is at the center of the top cap with edge squares on each side', () => {
    expect(faceAtSlot(2, 1)).toBe('+Y');
    expect(faceAtSlot(1, 1)).toBe('ePYw');
    expect(faceAtSlot(3, 1)).toBe('ePYe');
    expect(faceAtSlot(2, 0)).toBe('ePYn');
    expect(faceAtSlot(2, 2)).toBe('ePYs');
  });

  it('-Y is at the center of the bottom cap with edge squares on each side', () => {
    expect(faceAtSlot(2, 5)).toBe('-Y');
    expect(faceAtSlot(1, 5)).toBe('eNYw');
    expect(faceAtSlot(3, 5)).toBe('eNYe');
    expect(faceAtSlot(2, 4)).toBe('eNYn');
    expect(faceAtSlot(2, 6)).toBe('eNYs');
  });

  it('triangles fill the four corner slots of each cap', () => {
    // Top cap corners
    expect(faceKind(faceAtSlot(1, 0)!)).toBe('triangle');
    expect(faceKind(faceAtSlot(3, 0)!)).toBe('triangle');
    expect(faceKind(faceAtSlot(1, 2)!)).toBe('triangle');
    expect(faceKind(faceAtSlot(3, 2)!)).toBe('triangle');
    // Bottom cap corners
    expect(faceKind(faceAtSlot(1, 4)!)).toBe('triangle');
    expect(faceKind(faceAtSlot(3, 4)!)).toBe('triangle');
    expect(faceKind(faceAtSlot(1, 6)!)).toBe('triangle');
    expect(faceKind(faceAtSlot(3, 6)!)).toBe('triangle');
  });
});
