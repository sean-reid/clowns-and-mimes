// Cross-language bot-intercept fixture. Runs the canonical TS interceptPoint
// over fixed scenarios and records the predicted lead point to
// game/tests/fixtures/bot_intercept_snapshot.json. The GDScript test replays
// each and asserts BotIntercept.intercept_point lands on the same point - so the
// predictive aim / interception lead stays identical online and offline.
//
// Run via `pnpm gen:bot-intercept-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interceptPoint } from '../backend/room/src/botIntercept.ts';
import type { Vec2 } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_intercept_snapshot.json');

interface Scenario {
  name: string;
  shooter: Vec2;
  target: Vec2;
  vel: Vec2;
  speed: number;
}

const SCENARIOS: Scenario[] = [
  {
    // Stationary target: no lead, predict the current position.
    name: 'stationary',
    shooter: { x: 0, z: 0 },
    target: { x: 10, z: 0 },
    vel: { x: 0, z: 0 },
    speed: 16,
  },
  {
    // Target crossing perpendicular to the line of fire: lead ahead in z.
    name: 'crossing',
    shooter: { x: 0, z: 0 },
    target: { x: 10, z: 0 },
    vel: { x: 0, z: 4 },
    speed: 16,
  },
  {
    // Target closing on the shooter: aim a little nearer than its position.
    name: 'approaching',
    shooter: { x: 0, z: 0 },
    target: { x: 10, z: 0 },
    vel: { x: -4, z: 0 },
    speed: 16,
  },
  {
    // Slow chaser speed (interception, not a projectile): a much larger lead.
    name: 'slow_chaser',
    shooter: { x: 0, z: 0 },
    target: { x: 10, z: 0 },
    vel: { x: 0, z: 5 },
    speed: 6,
  },
];

function run(s: Scenario) {
  const p = interceptPoint(s.shooter, s.target, s.vel, s.speed, 'plane', 80);
  return { name: s.name, ...s, expected: { x: p.x, z: p.z } };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios
      .map((s) => `${s.name}=(${s.expected.x.toFixed(2)},${s.expected.z.toFixed(2)})`)
      .join(' | ')}`,
  );
}

void main();
