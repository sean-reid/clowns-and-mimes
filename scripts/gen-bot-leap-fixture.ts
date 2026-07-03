// Cross-language bot-leap fixture. Runs the canonical TS shouldLeapTraverse over
// fixed scenarios and records whether the bot should leap, to
// game/tests/fixtures/bot_leap_snapshot.json. The GDScript test replays each and
// asserts BotLeap.should_leap_traverse agrees - locking the "a wall lies in the
// way within reach and the landing is clear" predicate across both engines.
//
// Run via `pnpm gen:bot-leap-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldLeapTraverse } from '../backend/room/src/botLeap.ts';
import { BOT_LEAP_REACH } from '../backend/shared/src/botTuning.ts';
import type { Vec2 } from '../backend/shared/src/protocol.ts';
import type { WallSegment } from '../backend/shared/src/labyrinth.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_leap_snapshot.json');

const REACH = BOT_LEAP_REACH;

interface Scenario {
  name: string;
  bot: Vec2;
  goal: Vec2;
  walls: WallSegment[];
}

const SCENARIOS: Scenario[] = [
  {
    // A wall sits within reach between bot and goal; the landing past it is open.
    name: 'clear_wall',
    bot: { x: 0, z: 0 },
    goal: { x: 6, z: 0 },
    walls: [{ ax: 2, az: -3, bx: 2, bz: 3 }],
  },
  {
    // No walls: nothing to leap.
    name: 'no_wall',
    bot: { x: 0, z: 0 },
    goal: { x: 6, z: 0 },
    walls: [],
  },
  {
    // The wall is past leap reach (landing point doesn't clear it): wait.
    // Positioned relative to REACH so it stays beyond reach if REACH is retuned.
    name: 'wall_beyond_reach',
    bot: { x: 0, z: 0 },
    goal: { x: 10, z: 0 },
    walls: [{ ax: REACH + 2, az: -3, bx: REACH + 2, bz: 3 }],
  },
  {
    // The wall is so close the landing point lands on it: don't leap into it.
    // Just short of REACH so the landing (at REACH) falls within it, at any REACH.
    name: 'land_in_wall',
    bot: { x: 0, z: 0 },
    goal: { x: 6, z: 0 },
    walls: [{ ax: REACH - 0.2, az: -3, bx: REACH - 0.2, bz: 3 }],
  },
  {
    // A wall exists but off the line to the goal: nothing in the way.
    name: 'wall_off_path',
    bot: { x: 0, z: 0 },
    goal: { x: 6, z: 0 },
    walls: [{ ax: 1, az: 2, bx: 1, bz: 5 }],
  },
];

function run(s: Scenario) {
  const leap = shouldLeapTraverse(s.bot, s.goal, s.walls, 'plane', 80, REACH);
  return { name: s.name, bot: s.bot, goal: s.goal, walls: s.walls, expected: leap };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, reach: REACH, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(`scenarios: ${fixture.scenarios.map((s) => `${s.name}=${s.expected}`).join(' | ')}`);
}

void main();
