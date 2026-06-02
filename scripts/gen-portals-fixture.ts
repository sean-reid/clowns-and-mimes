// Cross-language portal-geometry fixture. Runs the canonical TS buildPortalPair
// over fixed scenarios (real maze walls, an origin + look yaw, and a fixed rng
// sequence for the random exit-wall pick) and records the resulting pair, to
// game/tests/fixtures/portals_snapshot.json. The GDScript test replays each
// with the identical rng sequence and asserts the same mouths, emergence
// points, and exit yaws.
//
// Run via `pnpm gen:portals-fixture`. A divergence means a portal opened
// offline would land somewhere different than online.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPortalPair } from '../backend/shared/src/portals.ts';
import { generateGridMazeWalls } from '../backend/shared/src/gridMaze.ts';
import type { Topology, Vec2 } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/portals_snapshot.json');

// Deterministic exit-wall draws; long enough that the do-while finds a wall
// other than the entry on the first or second try.
const RNG_SEQ = [0.13, 0.47, 0.81, 0.29, 0.66, 0.05, 0.91, 0.38];

interface Scenario {
  name: string;
  seed: number;
  topology: Topology;
  origin: Vec2;
  yaw: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'plane_a', seed: 12345, topology: 'plane', origin: { x: -4, z: -4 }, yaw: 0.0 },
  { name: 'plane_b', seed: 12345, topology: 'plane', origin: { x: 10, z: 6 }, yaw: 1.7 },
  { name: 'torus_a', seed: 42, topology: 'torus', origin: { x: 0, z: 0 }, yaw: 2.5 },
  { name: 'klein_a', seed: 7, topology: 'klein', origin: { x: 8, z: -8 }, yaw: -1.2 },
];

function runScenario(s: Scenario) {
  const walls = generateGridMazeWalls(s.seed, s.topology);
  let i = 0;
  const rng = () => RNG_SEQ[i++ % RNG_SEQ.length]!;
  const geom = buildPortalPair(s.origin, s.yaw, walls, s.topology, 80, rng);
  return { name: s.name, seed: s.seed, topology: s.topology, origin: s.origin, yaw: s.yaw, geom };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, rngSeq: RNG_SEQ, scenarios: SCENARIOS.map(runScenario) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(`scenarios: ${fixture.scenarios.map((s) => s.name).join(', ')}`);
}

void main();
