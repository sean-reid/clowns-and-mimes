// Cross-language gridMaze fixture. Generates wall lists from canonical
// TS generateGridMazeWalls for fixed (seed, topology) pairs, writes them
// to game/tests/fixtures/gridmaze_snapshot.json. The GDScript test reads
// the same JSON and asserts GridMaze.generate produces the identical
// wall list - same ordering, same coordinates.
//
// Run via `pnpm gen:gridmaze-fixture`. A divergence here is catastrophic:
// client and server would see different mazes from the same seed.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateGridMazeWalls } from '../backend/shared/src/gridMaze.ts';
import type { Topology } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/gridmaze_snapshot.json');

interface Scenario {
  name: string;
  seed: number;
  topology: Topology;
}

// Pick representative seeds. Small values keep the fixture readable;
// 0 and 1 stress the gapJitter hashing; the bigger seeds exercise
// different gap placements. All four topologies covered so the
// klein / mobius special-case paths are exercised too.
const SCENARIOS: Scenario[] = [
  { name: 'plane_seed_0', seed: 0, topology: 'plane' },
  { name: 'plane_seed_1', seed: 1, topology: 'plane' },
  { name: 'plane_seed_12345', seed: 12345, topology: 'plane' },
  { name: 'torus_seed_0', seed: 0, topology: 'torus' },
  { name: 'torus_seed_42', seed: 42, topology: 'torus' },
  { name: 'klein_seed_7', seed: 7, topology: 'klein' },
  { name: 'mobius_seed_3', seed: 3, topology: 'mobius' },
];

async function main(): Promise<void> {
  const scenarios = SCENARIOS.map((s) => ({
    name: s.name,
    seed: s.seed,
    topology: s.topology,
    walls: generateGridMazeWalls(s.seed, s.topology),
  }));
  const fixture = {
    schemaVersion: 1,
    scenarios,
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  const counts = scenarios.map((s) => `${s.name}=${s.walls.length}`).join(', ');
  console.log(`wrote ${OUTPUT}`);
  console.log(`wall counts: ${counts}`);
}

void main();
