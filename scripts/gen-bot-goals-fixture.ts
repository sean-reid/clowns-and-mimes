// Cross-language bot-goals fixture. Runs the canonical TS nearestItemTarget over
// fixed scenarios (plane + torus, in/out of seek radius, nearest-of-many, wrap)
// and records the chosen destination to game/tests/fixtures/bot_goals_snapshot.json.
// The GDScript test replays each and asserts BotGoals.nearest_item_target picks
// the same item (or null). Deterministic (distance compare, no RNG), so a
// mismatch is a genuine logic divergence.
//
// Run via `pnpm gen:bot-goals-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearestItemTarget } from '../backend/room/src/botGoals.ts';
import { WORLD_WIDTH } from '../backend/shared/src/topology.ts';
import type { Topology, Vec3 } from '@cm/shared';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_goals_snapshot.json');

interface Scenario {
  name: string;
  topology: Topology;
  botX: number;
  botZ: number;
  items: Array<{ x: number; z: number }>;
  seekRadius: number;
}

const item = (x: number, z: number): { position: Vec3 } => ({ position: { x, y: 0.5, z } });

const SCENARIOS: Scenario[] = [
  { name: 'none', topology: 'plane', botX: 0, botZ: 0, items: [], seekRadius: 12 },
  {
    name: 'out_of_range',
    topology: 'plane',
    botX: 0,
    botZ: 0,
    items: [{ x: 20, z: 0 }],
    seekRadius: 12,
  },
  {
    name: 'single_in_range',
    topology: 'plane',
    botX: 0,
    botZ: 0,
    items: [{ x: 5, z: 0 }],
    seekRadius: 12,
  },
  {
    name: 'nearest_of_three',
    topology: 'plane',
    botX: 0,
    botZ: 0,
    items: [
      { x: 9, z: 0 },
      { x: 3, z: 4 },
      { x: -8, z: 2 },
    ],
    seekRadius: 12,
  },
  {
    name: 'boundary_inclusive',
    topology: 'plane',
    botX: 0,
    botZ: 0,
    items: [{ x: 12, z: 0 }],
    seekRadius: 12,
  },
  {
    name: 'first_wins_on_tie',
    topology: 'plane',
    botX: 0,
    botZ: 0,
    items: [
      { x: 5, z: 0 },
      { x: 0, z: 5 },
    ],
    seekRadius: 12,
  },
  {
    name: 'torus_wrap_nearer',
    topology: 'torus',
    botX: -38,
    botZ: 0,
    items: [{ x: 38, z: 0 }],
    seekRadius: 12,
  },
];

function run(s: Scenario) {
  const best = nearestItemTarget(
    { x: s.botX, z: s.botZ },
    s.items.map((i) => item(i.x, i.z)),
    s.topology,
    WORLD_WIDTH,
    s.seekRadius,
  );
  return {
    name: s.name,
    topology: s.topology,
    botX: s.botX,
    botZ: s.botZ,
    items: s.items,
    seekRadius: s.seekRadius,
    expected: best ? { x: best.x, z: best.z } : null,
  };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios
      .map((s) => `${s.name}=${s.expected ? `(${s.expected.x},${s.expected.z})` : 'null'}`)
      .join(', ')}`,
  );
}

void main();
