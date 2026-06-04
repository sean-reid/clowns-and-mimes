// Coverage-aware patrol scoring for the bot AI. A patrolling bot keeps a visit
// grid (last-visited tick per cell, owned by the caller's mind); when it picks
// its next patrol point it favors cells it hasn't seen in a while - so it sweeps
// the map instead of pacing one spot - and biases toward continuing its current
// heading (anti-backtrack).
//
// Cells are the PATHFINDER's grid cells (caller passes cell indices from
// pathfinder.cellAt), so coverage tracking is topology-correct on every map -
// plane, torus, and the Klein/Möbius double covers - without this module
// knowing the world extents. Pure: it reads the visit map, the caller mutates
// it. Mirrored by game/scripts/bot_exploration.gd.

import type { Vec2 } from '@cm/shared';

export interface ExplorationParams {
  decayMs: number; // staleness saturates at this age
  momentumBonus: number; // weight of the keep-going-forward term vs staleness (0..1)
  spreadRadius: number; // teammates within this far penalize a candidate
  spreadWeight: number; // max teammate-repulsion penalty (at zero distance)
}

// Record that the bot occupied `cell` (a pathfinder cell index) at nowMs.
// Negative cell = no grid (no labyrinth); skipped.
export function markVisited(visited: Map<number, number>, cell: number, nowMs: number): void {
  if (cell >= 0) visited.set(cell, nowMs);
}

// Score a candidate patrol point: staleness of its cell (0..1, 1 = never or
// long-ago visited) plus a forward bonus for heading the way the bot already
// faces, minus a repulsion penalty for sitting near a teammate (so the team
// fans out). Higher is better; heading may be zero (no preference). candidateCell
// is the pathfinder cell of the candidate (negative when there's no grid);
// teammates are same-team player positions to spread away from.
export function patrolCandidateScore(
  candidate: Vec2,
  candidateCell: number,
  botPos: Vec2,
  heading: Vec2,
  visited: ReadonlyMap<number, number>,
  nowMs: number,
  params: ExplorationParams,
  teammates: readonly Vec2[] = [],
): number {
  const last = candidateCell >= 0 ? visited.get(candidateCell) : undefined;
  const age = last === undefined ? params.decayMs : nowMs - last;
  const staleness = Math.max(0, Math.min(1, age / params.decayMs));
  const dx = candidate.x - botPos.x;
  const dz = candidate.z - botPos.z;
  const len = Math.hypot(dx, dz);
  const hlen = Math.hypot(heading.x, heading.z);
  let forward = 0;
  if (len > 1e-6 && hlen > 1e-6) {
    forward = Math.max(0, (dx * heading.x + dz * heading.z) / (len * hlen));
  }
  // Team-spread: nearest teammate within the spread radius penalizes this
  // candidate, ramping to spreadWeight at zero distance.
  let crowd = 0;
  if (params.spreadRadius > 0) {
    let nearest = Infinity;
    for (const t of teammates) {
      const d = Math.hypot(candidate.x - t.x, candidate.z - t.z);
      if (d < nearest) nearest = d;
    }
    if (nearest < params.spreadRadius) {
      crowd = params.spreadWeight * (1 - nearest / params.spreadRadius);
    }
  }
  return staleness + params.momentumBonus * forward - crowd;
}
