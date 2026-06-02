// Cross-language item-layout fixture. Generates the deterministic floor layout
// + type rotation from the canonical TS items.ts for fixed (seed, topology)
// pairs, writes them to game/tests/fixtures/items_snapshot.json. The GDScript
// test reads the same JSON and asserts OfflineItems.item_spawn_layout /
// rotate_item_types produce the identical result - same ids, types, ordering,
// and positions.
//
// Run via `pnpm gen:items-fixture`. A divergence here means offline and online
// would spawn different power-ups in the same room.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemSpawnLayout, rotateItemTypes } from '../backend/shared/src/items.ts';
import type { Topology } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/items_snapshot.json');

interface Scenario {
  name: string;
  seed: number;
  topology: Topology;
}

// Representative seeds across all four topologies so the klein / mobius grid
// geometry and the spawn-keep / type-draw streams are all exercised.
const SCENARIOS: Scenario[] = [
  { name: 'plane_seed_0', seed: 0, topology: 'plane' },
  { name: 'plane_seed_1', seed: 1, topology: 'plane' },
  { name: 'plane_seed_12345', seed: 12345, topology: 'plane' },
  { name: 'torus_seed_42', seed: 42, topology: 'torus' },
  { name: 'klein_seed_7', seed: 7, topology: 'klein' },
  { name: 'mobius_seed_3', seed: 3, topology: 'mobius' },
];

async function main(): Promise<void> {
  const scenarios = SCENARIOS.map((s) => ({
    name: s.name,
    seed: s.seed,
    topology: s.topology,
    rotation: rotateItemTypes(s.seed),
    items: itemSpawnLayout(s.seed, s.topology),
  }));
  const fixture = { schemaVersion: 1, scenarios };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  const counts = scenarios.map((s) => `${s.name}=${s.items.length}`).join(', ');
  console.log(`wrote ${OUTPUT}`);
  console.log(`item counts: ${counts}`);
}

void main();
