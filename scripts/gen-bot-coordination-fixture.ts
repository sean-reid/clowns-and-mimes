// Cross-language bot-coordination fixture. Runs the canonical TS assignRescues
// over fixed rosters and records each bot's claimed ally to
// game/tests/fixtures/bot_coordination_snapshot.json. The GDScript test replays
// each and asserts BotCoordination.assign_rescues produces the same bot->ally
// matching, including the id tiebreak on equal-distance ties.
//
// Run via `pnpm gen:bot-coordination-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignRescues } from '../backend/room/src/botCoordination.ts';
import type { PlayerState, Team } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_coordination_snapshot.json');

const VISION = 22;

interface Spec {
  id: string;
  team: Team;
  x: number;
  z: number;
  frozen?: boolean;
}
interface Scenario {
  name: string;
  players: Spec[];
}

function player(s: Spec): PlayerState {
  return {
    id: s.id,
    name: s.id,
    team: s.team,
    bot: true,
    position: { x: s.x, y: 0.5, z: s.z },
    yaw: 0,
    frozen: s.frozen ?? false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'lone',
    players: [
      { id: 'b', team: 'mime', x: 0, z: 0 },
      { id: 'a', team: 'mime', x: 5, z: 0, frozen: true },
    ],
  },
  {
    name: 'spread_two',
    players: [
      { id: 'b1', team: 'mime', x: 0, z: 0 },
      { id: 'b2', team: 'mime', x: 1, z: 0 },
      { id: 'a1', team: 'mime', x: 3, z: 0, frozen: true },
      { id: 'a2', team: 'mime', x: 12, z: 0, frozen: true },
    ],
  },
  {
    name: 'surplus_bot_unassigned',
    players: [
      { id: 'b1', team: 'mime', x: 0, z: 0 },
      { id: 'b2', team: 'mime', x: 2, z: 0 },
      { id: 'a1', team: 'mime', x: 1, z: 0, frozen: true },
    ],
  },
  {
    name: 'excludes_enemy_awake_and_frozen_rescuer',
    players: [
      { id: 'b', team: 'mime', x: 0, z: 0 },
      { id: 'e', team: 'clown', x: 2, z: 0, frozen: true },
      { id: 'w', team: 'mime', x: 2, z: 0 },
      { id: 'fb', team: 'mime', x: 30, z: 0, frozen: true },
    ],
  },
  {
    name: 'out_of_vision',
    players: [
      { id: 'b', team: 'mime', x: 0, z: 0 },
      { id: 'a', team: 'mime', x: 30, z: 0, frozen: true },
    ],
  },
  {
    // Every pair is distance 5 -> the id tiebreak decides: b1 before b2, a1
    // before a2, so b1->a1 then b2->a2.
    name: 'tie_broken_by_id',
    players: [
      { id: 'b1', team: 'mime', x: 0, z: 0 },
      { id: 'b2', team: 'mime', x: 0, z: 0 },
      { id: 'a1', team: 'mime', x: 5, z: 0, frozen: true },
      { id: 'a2', team: 'mime', x: -5, z: 0, frozen: true },
    ],
  },
];

function run(s: Scenario) {
  const claims = assignRescues(s.players.map(player), 'plane', 80, VISION);
  const expected: Record<string, string> = {};
  for (const [botId, claim] of claims) expected[botId] = claim.target.id;
  return { name: s.name, players: s.players, expected };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, vision: VISION, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios
      .map(
        (s) =>
          `${s.name}={${Object.entries(s.expected)
            .map(([b, a]) => `${b}->${a}`)
            .join(',')}}`,
      )
      .join(' | ')}`,
  );
}

void main();
