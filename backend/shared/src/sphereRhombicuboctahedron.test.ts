import { describe, expect, it } from 'vitest';
import {
  ADJACENCY,
  AXIAL_FACES,
  CAP_EDGE_FACES,
  EQUATOR_EDGE_FACES,
  FACE_SLOTS,
  NET_COLS,
  NET_ROWS,
  TRIANGLE_FACES,
  crossEdge,
  faceAtSlot,
  faceKind,
  faceLocalToWorld,
  faceWorldRect,
  isWalkable,
  rotateFaceLocal,
  slotOf,
  spherePlayfieldExtents,
  stepAcrossSphereFaces,
  worldToFace,
  worldToFaceLocal,
} from './sphereRhombicuboctahedron.ts';

type Edge = 'east' | 'north' | 'west' | 'south';
const EDGES: Edge[] = ['east', 'north', 'west', 'south'];
const FACE_SIDE = 8;

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

describe('adjacency', () => {
  it('every walkable face has at least one adjacency entry', () => {
    for (const face of Object.keys(FACE_SLOTS)) {
      if (!isWalkable(face)) continue;
      expect(ADJACENCY[face]).toBeDefined();
      expect(Object.keys(ADJACENCY[face]!).length).toBeGreaterThan(0);
    }
  });

  it('round trips return home with rotations summing to 0 mod 4', () => {
    for (const face of Object.keys(ADJACENCY)) {
      for (const edge of EDGES) {
        const adj = ADJACENCY[face]?.[edge];
        if (!adj) continue;
        const back = ADJACENCY[adj.toFace]?.[adj.toEdge];
        expect(back).toBeDefined();
        expect(back!.toFace).toBe(face);
        expect(back!.toEdge).toBe(edge);
        expect((adj.rotation + back!.rotation) % 4).toBe(0);
      }
    }
  });

  it('never lands on a triangle barrier', () => {
    for (const face of Object.keys(ADJACENCY)) {
      for (const edge of EDGES) {
        const adj = ADJACENCY[face]?.[edge];
        if (!adj) continue;
        expect(isWalkable(adj.toFace)).toBe(true);
      }
    }
  });

  it('eL east identifies to -X west, no rotation', () => {
    const a = ADJACENCY.eL?.east;
    expect(a?.toFace).toBe('-X');
    expect(a?.toEdge).toBe('west');
    expect(a?.rotation).toBe(0);
  });

  it('ePYn north identifies to -Z north with a parameter flip', () => {
    const a = ADJACENCY.ePYn?.north;
    expect(a?.toFace).toBe('-Z');
    expect(a?.toEdge).toBe('north');
    expect(a?.rotation === 1 || a?.rotation === 3).toBe(true);
  });

  it('ePYe east identifies to +X north with no parameter flip', () => {
    const a = ADJACENCY.ePYe?.east;
    expect(a?.toFace).toBe('+X');
    expect(a?.toEdge).toBe('north');
    expect(a?.rotation === 0 || a?.rotation === 2).toBe(true);
  });
});

describe('rotateFaceLocal', () => {
  it('keeps points inside the unit square', () => {
    for (const r of [0, 1, 2, 3] as const) {
      for (const c of [
        { u: 0, v: 0 },
        { u: 1, v: 1 },
        { u: 0.3, v: 0.7 },
      ]) {
        const out = rotateFaceLocal(c.u, c.v, r);
        expect(out.u).toBeGreaterThanOrEqual(0);
        expect(out.u).toBeLessThanOrEqual(1);
        expect(out.v).toBeGreaterThanOrEqual(0);
        expect(out.v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rotation 0 is the identity', () => {
    const r = rotateFaceLocal(0.42, 0.13, 0);
    expect(r.u).toBeCloseTo(0.42, 6);
    expect(r.v).toBeCloseTo(0.13, 6);
  });

  it('four quarter-turns equal the identity', () => {
    let u = 0.42;
    let v = 0.13;
    for (let i = 0; i < 4; i += 1) {
      const r = rotateFaceLocal(u, v, 1);
      u = r.u;
      v = r.v;
    }
    expect(u).toBeCloseTo(0.42, 6);
    expect(v).toBeCloseTo(0.13, 6);
  });
});

describe('crossEdge', () => {
  it('lands on the receiving edge for the equator wrap', () => {
    const out = crossEdge('eL', 'east', 0.3);
    expect(out).not.toBeNull();
    expect(out!.face).toBe('-X');
    expect(out!.u).toBe(0);
    expect(out!.v).toBeCloseTo(0.3, 6);
  });

  it('round trip across the equator wrap returns home', () => {
    const out = crossEdge('eL', 'east', 0.3);
    const back = crossEdge(out!.face, 'west', out!.v);
    expect(back).not.toBeNull();
    expect(back!.face).toBe('eL');
    expect(back!.u).toBe(1);
    expect(back!.v).toBeCloseTo(0.3, 6);
  });

  it('flips the parameter on a cap identification with rotation 1 or 3', () => {
    const out = crossEdge('ePYn', 'north', 0.3);
    expect(out!.face).toBe('-Z');
    expect(out!.v).toBe(1);
    expect(out!.u).toBeCloseTo(0.7, 6);
  });

  it('preserves the parameter on a cap identification with rotation 0', () => {
    const out = crossEdge('ePYe', 'east', 0.3);
    expect(out!.face).toBe('+X');
    expect(out!.v).toBe(1);
    expect(out!.u).toBeCloseTo(0.3, 6);
  });

  it('returns null when the edge has no walkable adjacency', () => {
    // ePYn east borders a triangle barrier.
    expect(crossEdge('ePYn', 'east', 0.5)).toBeNull();
  });
});

describe('world layout', () => {
  it('playfield extents are NET_COLS * faceSide wide and NET_ROWS tall', () => {
    const ext = spherePlayfieldExtents(FACE_SIDE);
    expect(ext.x).toBe(NET_COLS * FACE_SIDE);
    expect(ext.z).toBe(NET_ROWS * FACE_SIDE);
  });

  it('faceWorldRect covers exactly one faceSide square per axis', () => {
    for (const face of Object.keys(FACE_SLOTS)) {
      const r = faceWorldRect(face, FACE_SIDE);
      expect(r.xMax - r.xMin).toBeCloseTo(FACE_SIDE, 6);
      expect(r.zMax - r.zMin).toBeCloseTo(FACE_SIDE, 6);
    }
  });

  it('worldToFace returns the face for an interior point of a walkable rect', () => {
    for (const face of Object.keys(FACE_SLOTS)) {
      if (!isWalkable(face)) continue;
      const r = faceWorldRect(face, FACE_SIDE);
      const cx = (r.xMin + r.xMax) / 2;
      const cz = (r.zMin + r.zMax) / 2;
      expect(worldToFace(cx, cz, FACE_SIDE)).toBe(face);
    }
  });

  it('worldToFace returns null for triangle cells', () => {
    for (const face of TRIANGLE_FACES) {
      const r = faceWorldRect(face, FACE_SIDE);
      const cx = (r.xMin + r.xMax) / 2;
      const cz = (r.zMin + r.zMax) / 2;
      expect(worldToFace(cx, cz, FACE_SIDE)).toBeNull();
    }
  });

  it('worldToFace returns null for void cells outside the unfold arms', () => {
    // (col=0, row=0) is a void corner; (col=7, row=2) is outside the cap arm.
    const voidSlots: [number, number][] = [
      [0, 0],
      [7, 0],
      [0, 6],
      [7, 2],
    ];
    const halfX = (NET_COLS * FACE_SIDE) / 2;
    const halfZ = (NET_ROWS * FACE_SIDE) / 2;
    for (const [col, row] of voidSlots) {
      const cx = col * FACE_SIDE - halfX + FACE_SIDE / 2;
      const cz = halfZ - row * FACE_SIDE - FACE_SIDE / 2;
      expect(worldToFace(cx, cz, FACE_SIDE)).toBeNull();
    }
  });

  it('faceLocalToWorld and worldToFaceLocal round-trip', () => {
    for (const face of Object.keys(FACE_SLOTS)) {
      if (!isWalkable(face)) continue;
      for (const u of [0.1, 0.5, 0.9]) {
        for (const v of [0.1, 0.5, 0.9]) {
          const w = faceLocalToWorld(face, u, v, FACE_SIDE);
          const back = worldToFaceLocal(face, w.x, w.z, FACE_SIDE);
          expect(back.u).toBeCloseTo(u, 6);
          expect(back.v).toBeCloseTo(v, 6);
        }
      }
    }
  });
});

describe('stepAcrossSphereFaces', () => {
  it('returns the destination unchanged when both endpoints are on the same face', () => {
    const rect = faceWorldRect('+Z', FACE_SIDE);
    const prev = { x: (rect.xMin + rect.xMax) / 2, z: (rect.zMin + rect.zMax) / 2 };
    const next = { x: prev.x + 1, z: prev.z + 0.5 };
    const out = stepAcrossSphereFaces(prev, next, FACE_SIDE);
    expect(out.x).toBeCloseTo(next.x, 6);
    expect(out.z).toBeCloseTo(next.z, 6);
  });

  it('steps east off +Z directly onto eS (grid-adjacent)', () => {
    const rect = faceWorldRect('+Z', FACE_SIDE);
    const prev = { x: rect.xMax - 0.1, z: (rect.zMin + rect.zMax) / 2 };
    const next = { x: rect.xMax + 0.2, z: (rect.zMin + rect.zMax) / 2 };
    const out = stepAcrossSphereFaces(prev, next, FACE_SIDE);
    expect(worldToFace(out.x, out.z, FACE_SIDE)).toBe('eS');
  });

  it('steps west off -X and wraps around the equator to eL', () => {
    const rect = faceWorldRect('-X', FACE_SIDE);
    const prev = { x: rect.xMin + 0.1, z: (rect.zMin + rect.zMax) / 2 };
    const next = { x: rect.xMin - 0.2, z: (rect.zMin + rect.zMax) / 2 };
    const out = stepAcrossSphereFaces(prev, next, FACE_SIDE);
    expect(worldToFace(out.x, out.z, FACE_SIDE)).toBe('eL');
  });

  it('steps north off +X via the cap-edge identification onto ePYe', () => {
    const rect = faceWorldRect('+X', FACE_SIDE);
    const prev = { x: (rect.xMin + rect.xMax) / 2, z: rect.zMax - 0.1 };
    const next = { x: (rect.xMin + rect.xMax) / 2, z: rect.zMax + 0.2 };
    const out = stepAcrossSphereFaces(prev, next, FACE_SIDE);
    expect(worldToFace(out.x, out.z, FACE_SIDE)).toBe('ePYe');
  });

  it('steps north off ePYn via identification onto -Z', () => {
    const rect = faceWorldRect('ePYn', FACE_SIDE);
    const prev = { x: (rect.xMin + rect.xMax) / 2, z: rect.zMax - 0.1 };
    const next = { x: (rect.xMin + rect.xMax) / 2, z: rect.zMax + 0.2 };
    const out = stepAcrossSphereFaces(prev, next, FACE_SIDE);
    expect(worldToFace(out.x, out.z, FACE_SIDE)).toBe('-Z');
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
