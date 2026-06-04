// Cross-language bot-exploration fixture. Runs the canonical TS
// patrolCandidateScore over fixed scenarios and records the score to
// game/tests/fixtures/bot_exploration_snapshot.json. The GDScript test replays
// each and asserts BotExploration.patrol_candidate_score matches. Deterministic
// (pure arithmetic, no RNG), so a mismatch is a genuine logic divergence.
//
// Run via `pnpm gen:bot-exploration-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  patrolCandidateScore,
  type ExplorationParams,
} from '../backend/room/src/botExploration.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_exploration_snapshot.json');

const PARAMS: ExplorationParams = {
  decayMs: 12000,
  momentumBonus: 0.5,
  spreadRadius: 24,
  spreadWeight: 0.7,
};
const NOW = 100000;

interface Scenario {
  name: string;
  candidateX: number;
  candidateZ: number;
  candidateCell: number;
  botX: number;
  botZ: number;
  headingX: number;
  headingZ: number;
  // cell -> last-visited ms
  visited: Record<number, number>;
  // same-team positions to spread away from (default none)
  teammates?: Array<{ x: number; z: number }>;
}

const SCENARIOS: Scenario[] = [
  // Never-visited cell, no heading preference -> full staleness, no bonus.
  {
    name: 'unvisited',
    candidateX: 0,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 0,
    headingZ: 0,
    visited: {},
  },
  // Just visited -> zero staleness.
  {
    name: 'just_visited',
    candidateX: 0,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 0,
    headingZ: 0,
    visited: { 5: NOW },
  },
  // Half the decay window elapsed -> half staleness.
  {
    name: 'half_stale',
    candidateX: 0,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 0,
    headingZ: 0,
    visited: { 5: NOW - 6000 },
  },
  // Just-visited cell but candidate is straight ahead -> pure momentum bonus.
  {
    name: 'momentum_forward',
    candidateX: 10,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 1,
    headingZ: 0,
    visited: { 5: NOW },
  },
  // Candidate behind the heading -> no bonus.
  {
    name: 'momentum_backward',
    candidateX: 10,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: -1,
    headingZ: 0,
    visited: { 5: NOW },
  },
  // Diagonal -> partial bonus.
  {
    name: 'momentum_diagonal',
    candidateX: 10,
    candidateZ: 10,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 1,
    headingZ: 0,
    visited: { 5: NOW },
  },
  // No grid (cell < 0) -> treated as never visited.
  {
    name: 'no_grid',
    candidateX: 0,
    candidateZ: 0,
    candidateCell: -1,
    botX: 0,
    botZ: 0,
    headingX: 0,
    headingZ: 0,
    visited: { 5: NOW },
  },
  // Team-spread: a fresh cell with a teammate beyond the radius -> no penalty.
  {
    name: 'teammate_far',
    candidateX: 0,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 0,
    headingZ: 0,
    visited: {},
    teammates: [{ x: 40, z: 0 }],
  },
  // Teammate halfway inside the spread radius -> partial penalty.
  {
    name: 'teammate_near',
    candidateX: 0,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 0,
    headingZ: 0,
    visited: {},
    teammates: [{ x: 12, z: 0 }],
  },
  // Teammate right on the candidate -> full spread penalty.
  {
    name: 'teammate_on_top',
    candidateX: 0,
    candidateZ: 0,
    candidateCell: 5,
    botX: 0,
    botZ: 0,
    headingX: 0,
    headingZ: 0,
    visited: {},
    teammates: [{ x: 0, z: 0 }],
  },
];

function run(s: Scenario) {
  const visited = new Map<number, number>(
    Object.entries(s.visited).map(([k, v]) => [Number(k), v]),
  );
  const score = patrolCandidateScore(
    { x: s.candidateX, z: s.candidateZ },
    s.candidateCell,
    { x: s.botX, z: s.botZ },
    { x: s.headingX, z: s.headingZ },
    visited,
    NOW,
    PARAMS,
    s.teammates ?? [],
  );
  return { ...s, expected: score };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, now: NOW, params: PARAMS, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios.map((s) => `${s.name}=${s.expected.toFixed(3)}`).join(', ')}`,
  );
}

void main();
