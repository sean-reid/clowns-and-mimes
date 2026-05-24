import { describe, expect, it } from 'vitest';
import {
  CUBE_ADJACENCY,
  CUBE_FACES,
  FACE_GRID_COLS,
  FACE_GRID_ROWS,
  FACE_SLOTS,
  crossEdge,
  rotateFaceLocal,
  type CubeFace,
  type Edge,
} from './sphereCubeMap.ts';

const EDGES: Edge[] = ['east', 'north', 'west', 'south'];

describe('cube face layout', () => {
  it('places six faces in the 4x3 T-net with no collisions', () => {
    const seen = new Set<string>();
    for (const face of CUBE_FACES) {
      const slot = FACE_SLOTS[face];
      expect(slot.col).toBeGreaterThanOrEqual(0);
      expect(slot.col).toBeLessThan(FACE_GRID_COLS);
      expect(slot.row).toBeGreaterThanOrEqual(0);
      expect(slot.row).toBeLessThan(FACE_GRID_ROWS);
      const key = `${slot.col},${slot.row}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(6);
  });
});

describe('cube edge adjacency', () => {
  it('every edge crosses to a real face and the round trip returns home', () => {
    for (const face of CUBE_FACES) {
      for (const edge of EDGES) {
        const adj = CUBE_ADJACENCY[face][edge];
        expect(CUBE_FACES).toContain(adj.toFace);
        const back = CUBE_ADJACENCY[adj.toFace][adj.toEdge];
        expect(back.toFace).toBe(face);
        expect(back.toEdge).toBe(edge);
        expect((adj.rotation + back.rotation) % 4).toBe(0);
      }
    }
  });

  it('opposite faces never share an edge', () => {
    const opposites: [CubeFace, CubeFace][] = [
      ['+X', '-X'],
      ['+Y', '-Y'],
      ['+Z', '-Z'],
    ];
    for (const [a, b] of opposites) {
      for (const edge of EDGES) {
        expect(CUBE_ADJACENCY[a][edge].toFace).not.toBe(b);
      }
    }
  });

  it('each face has four distinct neighbours and never itself', () => {
    for (const face of CUBE_FACES) {
      const neighbours = new Set<CubeFace>();
      for (const edge of EDGES) {
        neighbours.add(CUBE_ADJACENCY[face][edge].toFace);
      }
      expect(neighbours.size).toBe(4);
      expect(neighbours.has(face)).toBe(false);
    }
  });

  it('equator faces form a 4-cycle east via +Z -> +X -> -Z -> -X -> +Z', () => {
    let face: CubeFace = '+Z';
    const visited: CubeFace[] = [face];
    for (let i = 0; i < 4; i += 1) {
      face = CUBE_ADJACENCY[face].east.toFace;
      visited.push(face);
    }
    expect(visited).toEqual(['+Z', '+X', '-Z', '-X', '+Z']);
  });
});

describe('rotateFaceLocal', () => {
  it('keeps points inside the unit square for every rotation step', () => {
    const cases: Array<{ u: number; v: number }> = [
      { u: 0, v: 0 },
      { u: 1, v: 0 },
      { u: 0, v: 1 },
      { u: 1, v: 1 },
      { u: 0.3, v: 0.7 },
    ];
    for (const r of [0, 1, 2, 3] as const) {
      for (const c of cases) {
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
  it('lands the destination point on the receiving edge for equator crossings', () => {
    const out = crossEdge('+Z', 'east', 0.7);
    expect(out.face).toBe('+X');
    expect(out.u).toBe(0); // arriving on +X's west edge
    expect(out.v).toBeCloseTo(0.7, 6);
  });

  it('symmetric round trip across an equator edge', () => {
    const out = crossEdge('+Z', 'east', 0.3);
    const back = crossEdge(out.face, 'west', out.v);
    expect(back.face).toBe('+Z');
    expect(back.u).toBe(1); // back on +Z's east edge
    expect(back.v).toBeCloseTo(0.3, 6);
  });

  it('+Z north edge lands on +Y south edge, no rotation, parameter preserved', () => {
    const out = crossEdge('+Z', 'north', 0.42);
    expect(out.face).toBe('+Y');
    expect(out.v).toBe(0); // arriving on +Y's south edge
    expect(out.u).toBeCloseTo(0.42, 6);
  });

  it('+Z south edge lands on -Y north edge, no rotation, parameter preserved', () => {
    const out = crossEdge('+Z', 'south', 0.42);
    expect(out.face).toBe('-Y');
    expect(out.v).toBe(1); // arriving on -Y's north edge
    expect(out.u).toBeCloseTo(0.42, 6);
  });
});
