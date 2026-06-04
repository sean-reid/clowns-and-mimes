// Cross-language bot-flee fixture. Runs the canonical TS bestFleeTarget over
// fixed scenarios and records the chosen flee point to
// game/tests/fixtures/bot_flee_snapshot.json. The GDScript test replays each
// and asserts BotFlee.best_flee_target lands on the same point - so the escape
// scoring (enemy distance reward, dead-end + blocked-direction penalties, and
// the argmax tie-break) stays identical online and offline.
//
// Run via `pnpm gen:bot-flee-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestFleeTarget } from '../backend/room/src/botFlee.ts';
import { BOT_FLEE_PROJECTION } from '../backend/shared/src/botTuning.ts';
import type { Vec2 } from '../backend/shared/src/protocol.ts';
import type { WallSegment } from '../backend/shared/src/labyrinth.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_flee_snapshot.json');

const PROJECTION = BOT_FLEE_PROJECTION;

interface Scenario {
  name: string;
  bot: Vec2;
  threat: Vec2;
  enemies: Vec2[];
  walls?: WallSegment[];
}

const SCENARIOS: Scenario[] = [
  {
    // Open field, single threat: flee straight away (the anchor candidate).
    name: 'open_field',
    bot: { x: 0, z: 0 },
    threat: { x: 5, z: 0 },
    enemies: [{ x: 5, z: 0 }],
  },
  {
    // A second enemy sits straight along the away vector, so the bot must
    // redirect to a side lane instead of fleeing into it.
    name: 'second_enemy_redirect',
    bot: { x: 0, z: 0 },
    threat: { x: 5, z: 0 },
    enemies: [
      { x: 5, z: 0 },
      { x: -10, z: 0 },
    ],
  },
  {
    // A wall blocks the straight-away direction (a dead-end); the bot picks an
    // open escape lane instead.
    name: 'dead_end_avoided',
    bot: { x: 0, z: 0 },
    threat: { x: 5, z: 0 },
    enemies: [{ x: 5, z: 0 }],
    walls: [{ ax: -6, az: -4, bx: -6, bz: 4 }],
  },
];

function run(s: Scenario) {
  const goal = bestFleeTarget(s.bot, s.threat, s.enemies, s.walls ?? [], 'plane', 80, PROJECTION);
  return {
    name: s.name,
    bot: s.bot,
    threat: s.threat,
    enemies: s.enemies,
    walls: s.walls ?? [],
    expected: { goalX: goal.x, goalZ: goal.z },
  };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, projection: PROJECTION, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios
      .map((s) => `${s.name}=(${s.expected.goalX.toFixed(1)},${s.expected.goalZ.toFixed(1)})`)
      .join(' | ')}`,
  );
}

void main();
