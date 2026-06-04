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
import { nearestItemTarget, portalEscapeTarget } from '../backend/room/src/botGoals.ts';
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
  // Item-denial inputs (omitted -> pure nearest, matching the defaults).
  enemies?: Array<{ x: number; z: number }>;
  contestRadius?: number;
  denyWeight?: number;
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
  {
    // Item denial: the nearer item A(3) is uncontested, but B(10) is contested
    // by an enemy at (21) the bot can still beat (10 <= 11), so it detours for B.
    name: 'deny_contested',
    topology: 'plane',
    botX: 0,
    botZ: 0,
    items: [
      { x: 3, z: 0 },
      { x: 10, z: 0 },
    ],
    seekRadius: 16,
    enemies: [{ x: 21, z: 0 }],
    contestRadius: 12,
    denyWeight: 8,
  },
  {
    // Same items, but the enemy is far from both: no contest, so the bot just
    // takes the nearest (A) - the denial bias falls back to plain nearest.
    name: 'deny_fallback_uncontested',
    topology: 'plane',
    botX: 0,
    botZ: 0,
    items: [
      { x: 3, z: 0 },
      { x: 10, z: 0 },
    ],
    seekRadius: 16,
    enemies: [{ x: 60, z: 0 }],
    contestRadius: 12,
    denyWeight: 8,
  },
];

// portalEscapeTarget scenarios: entry at +5, exit at -5 on the x axis.
interface PortalScenario {
  name: string;
  topology: Topology;
  botX: number;
  botZ: number;
  awayX: number;
  awayZ: number;
  entryX: number;
  entryZ: number;
  exitX: number;
  exitZ: number;
}

const PORTAL_SCENARIOS: PortalScenario[] = [
  // On the entry side and the mouth is in the flee hemisphere -> take it.
  {
    name: 'entry_side_in_hemisphere',
    topology: 'plane',
    botX: 3,
    botZ: 0,
    awayX: 1,
    awayZ: 0,
    entryX: 5,
    entryZ: 0,
    exitX: -5,
    exitZ: 0,
  },
  // Closer to the exit than the entry -> ignore (would teleport back).
  {
    name: 'exit_side',
    topology: 'plane',
    botX: -3,
    botZ: 0,
    awayX: 1,
    awayZ: 0,
    entryX: 5,
    entryZ: 0,
    exitX: -5,
    exitZ: 0,
  },
  // On the entry side but the mouth is behind the flee direction -> ignore.
  {
    name: 'wrong_hemisphere',
    topology: 'plane',
    botX: 3,
    botZ: 0,
    awayX: -1,
    awayZ: 0,
    entryX: 5,
    entryZ: 0,
    exitX: -5,
    exitZ: 0,
  },
];

function runPortal(s: PortalScenario) {
  const mouth = portalEscapeTarget(
    { x: s.botX, z: s.botZ },
    { x: s.awayX, z: s.awayZ },
    { x: s.entryX, z: s.entryZ },
    { x: s.exitX, z: s.exitZ },
    s.topology,
    WORLD_WIDTH,
  );
  return { ...s, expected: mouth ? { x: mouth.x, z: mouth.z } : null };
}

function run(s: Scenario) {
  const best = nearestItemTarget(
    { x: s.botX, z: s.botZ },
    s.items.map((i) => item(i.x, i.z)),
    s.topology,
    WORLD_WIDTH,
    s.seekRadius,
    s.enemies ?? [],
    s.contestRadius ?? 0,
    s.denyWeight ?? 0,
  );
  return {
    name: s.name,
    topology: s.topology,
    botX: s.botX,
    botZ: s.botZ,
    items: s.items,
    seekRadius: s.seekRadius,
    enemies: s.enemies ?? [],
    contestRadius: s.contestRadius ?? 0,
    denyWeight: s.denyWeight ?? 0,
    expected: best ? { x: best.x, z: best.z } : null,
  };
}

async function main(): Promise<void> {
  const fixture = {
    schemaVersion: 1,
    scenarios: SCENARIOS.map(run),
    portalScenarios: PORTAL_SCENARIOS.map(runPortal),
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `items: ${fixture.scenarios
      .map((s) => `${s.name}=${s.expected ? `(${s.expected.x},${s.expected.z})` : 'null'}`)
      .join(', ')}`,
  );
  console.log(
    `portal: ${fixture.portalScenarios
      .map((s) => `${s.name}=${s.expected ? `(${s.expected.x},${s.expected.z})` : 'null'}`)
      .join(', ')}`,
  );
}

void main();
