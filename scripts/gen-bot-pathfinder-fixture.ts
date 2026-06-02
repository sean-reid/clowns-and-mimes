// Cross-language bot-pathfinder fixture. Runs the canonical TS BotPathfinder
// (weighted A* + clearance funnel) over real maze walls for fixed (seed,
// topology) pairs and a set of from/to queries, writes the resulting waypoints
// to game/tests/fixtures/bot_pathfinder_snapshot.json. The GDScript test reads
// the same JSON, builds BotPathfinder from the identical walls, and asserts it
// returns the same waypoint for each query.
//
// Run via `pnpm gen:bot-pathfinder-fixture`. A divergence means offline and
// online bots would choose different routes through the same maze - including
// equal-cost A* tie-breaks the two implementations might resolve differently.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotPathfinder } from '../backend/room/src/botPathfinder.ts';
import { generateGridMazeWalls } from '../backend/shared/src/gridMaze.ts';
import type { Topology, Vec2 } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_pathfinder_snapshot.json');

interface Query {
  from: Vec2;
  to: Vec2;
  // Player positions to soft-avoid (the continuous occupancy field).
  avoid?: Vec2[];
}
interface Scenario {
  name: string;
  seed: number;
  topology: Topology;
  queries: Query[];
}

// A spread of from/to pairs that force multi-cell detours (where A* and the
// funnel actually do work, and where equal-cost ties are most likely).
const QUERIES: Query[] = [
  { from: { x: -32, z: -32 }, to: { x: 28, z: 28 } },
  { from: { x: -28, z: 30 }, to: { x: 30, z: -28 } },
  { from: { x: 0, z: -34 }, to: { x: 0, z: 34 } },
  { from: { x: -34, z: 4 }, to: { x: 34, z: 4 } },
  // Soft-occupancy detours (players make cells expensive, not blocked) stress
  // ties most. These four positions are the centers of cells (4,4)(5,4)(4,5)(5,5).
  {
    from: { x: -32, z: -32 },
    to: { x: 28, z: 28 },
    avoid: [
      { x: -4, z: -4 },
      { x: 4, z: -4 },
      { x: -4, z: 4 },
      { x: 4, z: 4 },
    ],
  },
];

const SCENARIOS: Array<{ name: string; seed: number; topology: Topology }> = [
  { name: 'plane_seed_0', seed: 0, topology: 'plane' },
  { name: 'plane_seed_12345', seed: 12345, topology: 'plane' },
  { name: 'torus_seed_42', seed: 42, topology: 'torus' },
  { name: 'klein_seed_7', seed: 7, topology: 'klein' },
  { name: 'mobius_seed_3', seed: 3, topology: 'mobius' },
];

async function main(): Promise<void> {
  const scenarios: Array<Scenario & { walls: unknown[]; results: Vec2[] }> = SCENARIOS.map((s) => {
    const walls = generateGridMazeWalls(s.seed, s.topology);
    const pf = new BotPathfinder(walls, s.topology);
    const results = QUERIES.map((q) =>
      q.avoid ? pf.nextWaypointAvoiding(q.from, q.to, q.avoid) : pf.nextWaypoint(q.from, q.to),
    );
    return { name: s.name, seed: s.seed, topology: s.topology, queries: QUERIES, walls, results };
  });
  const fixture = { schemaVersion: 1, scenarios };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(`scenarios: ${scenarios.map((s) => `${s.name}(${s.walls.length}w)`).join(', ')}`);
}

void main();
