// Cross-language bot-coordination fixture. Runs the canonical TS assignRescues
// and assignChases over fixed rosters and records each bot's claim to
// game/tests/fixtures/bot_coordination_snapshot.json. The GDScript test replays
// each and asserts BotCoordination.assign_rescues / assign_chases produce the
// same matching - the bot->ally rescue pairing (with the id tiebreak) and the
// bot->{target, flank goal} chase pincer slots.
//
// Run via `pnpm gen:bot-coordination-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignChases, assignRescues } from '../backend/room/src/botCoordination.ts';
import type { PlayerState, Team } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_coordination_snapshot.json');

const VISION = 22;
// Fixed wall-clock for the chase scenarios (no cloak in play, so the value only
// has to be stable across both engines).
const NOW = 1000;

interface Spec {
  id: string;
  team: Team;
  x: number;
  z: number;
  frozen?: boolean;
  bot?: boolean;
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
    bot: s.bot ?? true,
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

// Chase scenarios use non-bot enemies (so only the named mime bots are chasers)
// and an open field (no walls), exercising the pincer fan-out + the group-size
// and target-grouping rules.
const CHASE_SCENARIOS: Scenario[] = [
  {
    // Two bots stacked on the same side of one enemy: split to a near + far slot
    // (the second is routed behind the target) - the pincer.
    name: 'pincer_two',
    players: [
      { id: 'b1', team: 'mime', x: 0, z: 0 },
      { id: 'b2', team: 'mime', x: 1, z: 0 },
      { id: 'e', team: 'clown', x: 10, z: 0, bot: false },
    ],
  },
  {
    // Three clustered chasers spread to thirds around the target.
    name: 'pincer_three',
    players: [
      { id: 'b1', team: 'mime', x: 0, z: 0 },
      { id: 'b2', team: 'mime', x: 0, z: 1 },
      { id: 'b3', team: 'mime', x: 0, z: -1 },
      { id: 'e', team: 'clown', x: 10, z: 0, bot: false },
    ],
  },
  {
    // A lone chaser gets no claim - it drives straight at the target.
    name: 'solo_unclaimed',
    players: [
      { id: 'b', team: 'mime', x: 0, z: 0 },
      { id: 'e', team: 'clown', x: 5, z: 0, bot: false },
    ],
  },
  {
    // Two bots, two enemies, one each: each group has a single chaser, so
    // neither is claimed.
    name: 'separate_targets',
    players: [
      { id: 'b1', team: 'mime', x: 0, z: 0 },
      { id: 'e1', team: 'clown', x: 3, z: 0, bot: false },
      { id: 'b2', team: 'mime', x: 0, z: 20 },
      { id: 'e2', team: 'clown', x: 3, z: 20, bot: false },
    ],
  },
];

function run(s: Scenario) {
  const claims = assignRescues(s.players.map(player), 'plane', 80, VISION);
  const expected: Record<string, string> = {};
  for (const [botId, claim] of claims) expected[botId] = claim.target.id;
  return { name: s.name, players: s.players, expected };
}

function runChase(s: Scenario) {
  const claims = assignChases(s.players.map(player), [], 'plane', 80, NOW, VISION);
  const expected: Record<string, { targetId: string; goalX: number; goalZ: number }> = {};
  for (const [botId, claim] of claims) {
    expected[botId] = { targetId: claim.targetId, goalX: claim.goal.x, goalZ: claim.goal.z };
  }
  return { name: s.name, players: s.players, expected };
}

async function main(): Promise<void> {
  const fixture = {
    schemaVersion: 2,
    vision: VISION,
    now: NOW,
    scenarios: SCENARIOS.map(run),
    chaseScenarios: CHASE_SCENARIOS.map(runChase),
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `rescue: ${fixture.scenarios
      .map(
        (s) =>
          `${s.name}={${Object.entries(s.expected)
            .map(([b, a]) => `${b}->${a}`)
            .join(',')}}`,
      )
      .join(' | ')}`,
  );
  console.log(
    `chase: ${fixture.chaseScenarios
      .map(
        (s) =>
          `${s.name}={${Object.entries(s.expected)
            .map(([b, c]) => `${b}->${c.targetId}@(${c.goalX.toFixed(1)},${c.goalZ.toFixed(1)})`)
            .join(',')}}`,
      )
      .join(' | ')}`,
  );
}

void main();
