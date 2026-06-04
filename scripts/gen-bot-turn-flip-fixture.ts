// Cross-language bot-turn-flip fixture. Runs the canonical TS turnFlipReposition
// over fixed scenarios and records the pre-position target (or null) to
// game/tests/fixtures/bot_turn_flip_snapshot.json. The GDScript test replays each
// and asserts BotTurnFlip.turn_flip_reposition agrees - locking the retreat /
// pounce-standoff geometry and the imminence + can-tag gates across both engines.
//
// Run via `pnpm gen:bot-turn-flip-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { turnFlipReposition, type TurnFlipParams } from '../backend/room/src/botTurnFlip.ts';
import {
  BOT_FLEE_PROJECTION,
  BOT_TURN_ANTICIPATE_MS,
  BOT_TURN_STANDOFF_BUFFER,
  TAG_RADIUS_BOT,
} from '../backend/shared/src/botTuning.ts';
import { SPRINT_SPEED } from '../backend/shared/src/movement.ts';
import type { Vec2 } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_turn_flip_snapshot.json');

const PARAMS: TurnFlipParams = {
  anticipateMs: BOT_TURN_ANTICIPATE_MS,
  tagRadius: TAG_RADIUS_BOT,
  standoffBuffer: BOT_TURN_STANDOFF_BUFFER,
  sprintSpeed: SPRINT_SPEED,
  fleeProjection: BOT_FLEE_PROJECTION,
};

interface Scenario {
  name: string;
  bot: Vec2;
  enemy: Vec2;
  timeToFlipMs: number;
  botIsHunter: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    // Hunter about to become prey, can't tag in time: retreat away for a head start.
    name: 'hunter_retreat',
    bot: { x: 0, z: 0 },
    enemy: { x: 5, z: 0 },
    timeToFlipMs: 400,
    botIsHunter: true,
  },
  {
    // Hunter already in tag range: finish the tag, no reposition.
    name: 'hunter_can_tag',
    bot: { x: 0, z: 0 },
    enemy: { x: 1, z: 0 },
    timeToFlipMs: 400,
    botIsHunter: true,
  },
  {
    // Prey about to become hunter: close to the standoff ring to pounce.
    name: 'prey_pounce',
    bot: { x: 0, z: 0 },
    enemy: { x: 10, z: 0 },
    timeToFlipMs: 400,
    botIsHunter: false,
  },
  {
    // Flip not imminent yet: leave normal chase/flee alone.
    name: 'not_imminent',
    bot: { x: 0, z: 0 },
    enemy: { x: 10, z: 0 },
    timeToFlipMs: 5000,
    botIsHunter: false,
  },
  {
    // Flip already passed (clamped): no reposition.
    name: 'flip_passed',
    bot: { x: 0, z: 0 },
    enemy: { x: 10, z: 0 },
    timeToFlipMs: -10,
    botIsHunter: false,
  },
];

function run(s: Scenario) {
  const target = turnFlipReposition(
    s.bot,
    s.enemy,
    s.timeToFlipMs,
    s.botIsHunter,
    'plane',
    80,
    PARAMS,
  );
  return { ...s, expected: target ? { x: target.x, z: target.z } : null };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, params: PARAMS, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios
      .map(
        (s) =>
          `${s.name}=${s.expected ? `(${s.expected.x.toFixed(2)},${s.expected.z.toFixed(2)})` : 'null'}`,
      )
      .join(' | ')}`,
  );
}

void main();
