import { describe, expect, it } from 'vitest';
import { markVisited, patrolCandidateScore, type ExplorationParams } from './botExploration.ts';

const PARAMS: ExplorationParams = {
  decayMs: 12000,
  momentumBonus: 0.5,
  spreadRadius: 24,
  spreadWeight: 0.7,
};
const NOW = 100000;

describe('markVisited', () => {
  it('records a non-negative cell', () => {
    const v = new Map<number, number>();
    markVisited(v, 7, NOW);
    expect(v.get(7)).toBe(NOW);
  });

  it('ignores a negative cell (no grid)', () => {
    const v = new Map<number, number>();
    markVisited(v, -1, NOW);
    expect(v.size).toBe(0);
  });
});

describe('patrolCandidateScore', () => {
  const at = (x: number, z: number) => ({ x, z });
  const noHeading = at(0, 0);

  it('gives an unvisited cell full staleness', () => {
    const s = patrolCandidateScore(at(0, 0), 5, at(0, 0), noHeading, new Map(), NOW, PARAMS);
    expect(s).toBeCloseTo(1, 6);
  });

  it('gives a just-visited cell zero staleness', () => {
    const v = new Map([[5, NOW]]);
    const s = patrolCandidateScore(at(0, 0), 5, at(0, 0), noHeading, v, NOW, PARAMS);
    expect(s).toBeCloseTo(0, 6);
  });

  it('ramps staleness linearly to the decay window', () => {
    const v = new Map([[5, NOW - 6000]]);
    const s = patrolCandidateScore(at(0, 0), 5, at(0, 0), noHeading, v, NOW, PARAMS);
    expect(s).toBeCloseTo(0.5, 6);
  });

  it('adds the momentum bonus only for forward candidates', () => {
    const v = new Map([[5, NOW]]); // zero staleness, isolate momentum
    const forward = patrolCandidateScore(at(10, 0), 5, at(0, 0), at(1, 0), v, NOW, PARAMS);
    const backward = patrolCandidateScore(at(10, 0), 5, at(0, 0), at(-1, 0), v, NOW, PARAMS);
    expect(forward).toBeCloseTo(0.5, 6); // full forward * 0.5 bonus
    expect(backward).toBeCloseTo(0, 6);
  });

  it('treats a missing grid (cell < 0) as never visited', () => {
    const v = new Map([[5, NOW]]);
    const s = patrolCandidateScore(at(0, 0), -1, at(0, 0), noHeading, v, NOW, PARAMS);
    expect(s).toBeCloseTo(1, 6);
  });

  it('penalizes candidates near a teammate, ramping with distance', () => {
    const fresh = new Map<number, number>(); // staleness 1, isolate spread
    const far = patrolCandidateScore(at(0, 0), 5, at(0, 0), noHeading, fresh, NOW, PARAMS, [
      at(40, 0),
    ]);
    const near = patrolCandidateScore(at(0, 0), 5, at(0, 0), noHeading, fresh, NOW, PARAMS, [
      at(12, 0),
    ]);
    const onTop = patrolCandidateScore(at(0, 0), 5, at(0, 0), noHeading, fresh, NOW, PARAMS, [
      at(0, 0),
    ]);
    expect(far).toBeCloseTo(1, 6); // beyond radius -> no penalty
    expect(near).toBeCloseTo(0.65, 6); // 1 - 0.7*(1 - 12/24)
    expect(onTop).toBeCloseTo(0.3, 6); // 1 - 0.7
  });
});
