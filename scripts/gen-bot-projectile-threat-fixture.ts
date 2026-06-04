// Cross-language bot-projectile-threat fixture. Runs the canonical TS
// nearestProjectileThreat over fixed scenarios and records the flee-from bearing
// (or null) to game/tests/fixtures/bot_projectile_threat_snapshot.json. The
// GDScript test replays each and asserts BotProjectileThreat.nearest_projectile_threat
// returns the same point - locking the enemy / sight-range / line-of-sight /
// approaching filters and the reverse-trajectory bearing across both engines.
//
// Run via `pnpm gen:bot-projectile-threat-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nearestProjectileThreat,
  shouldDodgeProjectile,
  type SightedProjectile,
} from '../backend/room/src/botProjectileThreat.ts';
import {
  BOT_DODGE_LEAD_S,
  BOT_DODGE_RADIUS,
  BOT_FIRE_THREAT_LOOKBACK,
  BOT_VISION_RADIUS,
} from '../backend/shared/src/botTuning.ts';
import type { PlayerState, Team } from '../backend/shared/src/protocol.ts';
import type { WallSegment } from '../backend/shared/src/labyrinth.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_projectile_threat_snapshot.json');

const SIGHT = BOT_VISION_RADIUS;
const LOOKBACK = BOT_FIRE_THREAT_LOOKBACK;

interface ProjSpec {
  ownerId: string;
  team: Team;
  px: number;
  pz: number;
  vx: number;
  vz: number;
}
interface Scenario {
  name: string;
  bot: { id: string; team: Team; x: number; z: number };
  projectiles: ProjSpec[];
  walls?: WallSegment[];
}

function bot(s: Scenario['bot']): PlayerState {
  return {
    id: s.id,
    name: s.id,
    team: s.team,
    bot: true,
    position: { x: s.x, y: 0.5, z: s.z },
    yaw: 0,
    frozen: false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  };
}

function proj(s: ProjSpec): SightedProjectile {
  return {
    ownerId: s.ownerId,
    team: s.team,
    position: { x: s.px, z: s.pz },
    velocity: { x: s.vx, z: s.vz },
  };
}

const SCENARIOS: Scenario[] = [
  {
    // Enemy shot in sight, heading at the bot: flee from a bearing back along its
    // reverse trajectory (the shot came from +x, so the bearing is at +x).
    name: 'incoming_visible',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 8, pz: 0, vx: -16, vz: 0 }],
  },
  {
    // Same shot, but a wall blocks line of sight: not perceived.
    name: 'occluded',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 8, pz: 0, vx: -16, vz: 0 }],
    walls: [{ ax: 4, az: -3, bx: 4, bz: 3 }],
  },
  {
    // Beyond sight range: not perceived.
    name: 'out_of_sight',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 30, pz: 0, vx: -16, vz: 0 }],
  },
  {
    // Visible enemy shot flying away from the bot: not incoming, ignored.
    name: 'flying_away',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 8, pz: 0, vx: 16, vz: 0 }],
  },
  {
    // Friendly fire is not a threat.
    name: 'friendly_ignored',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'ally', team: 'mime', px: 8, pz: 0, vx: -16, vz: 0 }],
  },
  {
    // Two incoming shots: the nearer one's bearing wins.
    name: 'nearest_of_two',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [
      { ownerId: 'e1', team: 'clown', px: 15, pz: 0, vx: -16, vz: 0 },
      { ownerId: 'e2', team: 'clown', px: 6, pz: 0, vx: -16, vz: 0 },
    ],
  },
];

const DODGE_SCENARIOS: Scenario[] = [
  {
    // Shot heading dead-on, arriving inside the lead window: dodge.
    name: 'hit_imminent',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 4, pz: 0, vx: -16, vz: 0 }],
  },
  {
    // Parallel shot offset well to the side: misses, no dodge.
    name: 'passing_wide',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 4, pz: 5, vx: -16, vz: 0 }],
  },
  {
    // On a hit line but still too far out (impact beyond the lead window): wait.
    name: 'not_imminent',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 10, pz: 0, vx: -16, vz: 0 }],
  },
  {
    // Already past, moving away: no dodge.
    name: 'moving_away',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 4, pz: 0, vx: 16, vz: 0 }],
  },
  {
    // Dead-on hit, but a wall is between: not seen, no dodge.
    name: 'occluded',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'e', team: 'clown', px: 4, pz: 0, vx: -16, vz: 0 }],
    walls: [{ ax: 2, az: -3, bx: 2, bz: 3 }],
  },
  {
    // Friendly fire never triggers a dodge.
    name: 'friendly_ignored',
    bot: { id: 'b', team: 'mime', x: 0, z: 0 },
    projectiles: [{ ownerId: 'ally', team: 'mime', px: 4, pz: 0, vx: -16, vz: 0 }],
  },
];

function run(s: Scenario) {
  const threat = nearestProjectileThreat(
    bot(s.bot),
    s.projectiles.map(proj),
    s.walls ?? [],
    'plane',
    80,
    SIGHT,
    LOOKBACK,
  );
  return {
    name: s.name,
    bot: s.bot,
    projectiles: s.projectiles,
    walls: s.walls ?? [],
    expected: threat ? { x: threat.x, z: threat.z } : null,
  };
}

function runDodge(s: Scenario) {
  const dodge = shouldDodgeProjectile(
    bot(s.bot),
    s.projectiles.map(proj),
    s.walls ?? [],
    'plane',
    80,
    BOT_DODGE_RADIUS,
    BOT_DODGE_LEAD_S,
  );
  return {
    name: s.name,
    bot: s.bot,
    projectiles: s.projectiles,
    walls: s.walls ?? [],
    expected: dodge,
  };
}

async function main(): Promise<void> {
  const fixture = {
    schemaVersion: 2,
    sight: SIGHT,
    lookback: LOOKBACK,
    dodgeRadius: BOT_DODGE_RADIUS,
    dodgeLeadS: BOT_DODGE_LEAD_S,
    scenarios: SCENARIOS.map(run),
    dodgeScenarios: DODGE_SCENARIOS.map(runDodge),
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `threat: ${fixture.scenarios
      .map((s) => `${s.name}=${s.expected ? `(${s.expected.x},${s.expected.z})` : 'null'}`)
      .join(' | ')}`,
  );
  console.log(`dodge: ${fixture.dodgeScenarios.map((s) => `${s.name}=${s.expected}`).join(' | ')}`);
}

void main();
