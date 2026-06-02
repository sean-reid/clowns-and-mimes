// Cross-language bot-decision fixture. Runs the canonical TS decideBotAction
// over fixed scenarios and records the resulting decision + mutated engagement,
// to game/tests/fixtures/bot_decision_snapshot.json. The GDScript test replays
// each scenario and asserts BotDecision.decide produces the same mode, target,
// flags, and engagement-out. Deterministic (comparisons/argmax, no RNG), so a
// mismatch is a genuine logic divergence.
//
// Run via `pnpm gen:bot-decision-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideBotAction, type Engagement } from '../backend/room/src/botDecision.ts';
import type { PlayerState, Team } from '../backend/shared/src/protocol.ts';
import type { WallSegment } from '../backend/shared/src/labyrinth.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_decision_snapshot.json');

const PARAMS = { visionRadius: 22, shootRange: 18, retargetHysteresis: 0.75, investigateMs: 3000 };

interface PlayerSpec {
  id: string;
  team: Team;
  x: number;
  z: number;
  frozen?: boolean;
}
interface Scenario {
  name: string;
  bot: PlayerSpec;
  players: PlayerSpec[];
  walls?: WallSegment[];
  now: number;
  active: Team | null;
  engagement: Engagement;
}

function player(spec: PlayerSpec): PlayerState {
  return {
    id: spec.id,
    name: spec.id,
    team: spec.team,
    bot: false,
    position: { x: spec.x, y: 0.5, z: spec.z },
    yaw: 0,
    frozen: spec.frozen ?? false,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt: null,
  } as PlayerState;
}

const fresh = (): Engagement => ({
  engagedTargetId: null,
  lastKnownPos: null,
  investigateUntil: 0,
});
const WALL: WallSegment[] = [{ ax: 3, az: -6, bx: 3, bz: 6 }];

const SCENARIOS: Scenario[] = [
  {
    name: 'patrol',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [],
    now: 1000,
    active: 'mime',
    engagement: fresh(),
  },
  {
    name: 'chase',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [{ id: 'e', team: 'clown', x: 5, z: 0 }],
    now: 1000,
    active: 'mime',
    engagement: fresh(),
  },
  {
    name: 'flee',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [{ id: 'e', team: 'clown', x: 5, z: 0 }],
    now: 1000,
    active: 'clown',
    engagement: fresh(),
  },
  {
    name: 'rescue',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [{ id: 'a', team: 'mime', x: 4, z: 0, frozen: true }],
    now: 1000,
    active: 'mime',
    engagement: fresh(),
  },
  {
    name: 'flee_over_rescue',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [
      { id: 'e', team: 'clown', x: 5, z: 0 },
      { id: 'a', team: 'mime', x: 4, z: 0, frozen: true },
    ],
    now: 1000,
    active: 'clown',
    engagement: fresh(),
  },
  {
    name: 'hysteresis_keep',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [
      { id: 'A', team: 'clown', x: 10, z: 0 },
      { id: 'B', team: 'clown', x: 8, z: 0 },
    ],
    now: 1000,
    active: 'mime',
    engagement: { engagedTargetId: 'A', lastKnownPos: null, investigateUntil: 0 },
  },
  {
    name: 'retarget',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [
      { id: 'A', team: 'clown', x: 10, z: 0 },
      { id: 'B', team: 'clown', x: 6, z: 0 },
    ],
    now: 1000,
    active: 'mime',
    engagement: { engagedTargetId: 'A', lastKnownPos: null, investigateUntil: 0 },
  },
  {
    name: 'occlusion_investigate',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [{ id: 'e', team: 'clown', x: 10, z: 0 }],
    walls: WALL,
    now: 1000,
    active: 'mime',
    engagement: { engagedTargetId: 'e', lastKnownPos: null, investigateUntil: 0 },
  },
  {
    name: 'occlusion_drop',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [{ id: 'e', team: 'clown', x: 10, z: 0 }],
    walls: WALL,
    now: 1000,
    active: 'clown',
    engagement: { engagedTargetId: 'e', lastKnownPos: null, investigateUntil: 0 },
  },
  {
    name: 'investigate_expiry',
    bot: { id: 'bot', team: 'mime', x: 0, z: 0 },
    players: [],
    now: 1000,
    active: 'mime',
    engagement: { engagedTargetId: null, lastKnownPos: { x: 10, z: 0 }, investigateUntil: 500 },
  },
];

function run(s: Scenario) {
  const eng: Engagement = {
    ...s.engagement,
    lastKnownPos: s.engagement.lastKnownPos ? { ...s.engagement.lastKnownPos } : null,
  };
  const d = decideBotAction(
    player(s.bot),
    s.players.map(player),
    s.walls ?? [],
    'plane',
    80,
    s.now,
    s.active,
    eng,
    PARAMS,
  );
  const finite = (n: number) => (Number.isFinite(n) ? n : null);
  return {
    name: s.name,
    bot: s.bot,
    players: s.players,
    walls: s.walls ?? [],
    now: s.now,
    active: s.active,
    engagementIn: s.engagement,
    expected: {
      mode: d.mode,
      targetId: d.target?.id ?? null,
      enemyDist: finite(d.enemyDist),
      rescueTargetId: d.rescueTarget?.id ?? null,
      chasing: d.chasing,
      fleeing: d.fleeing,
      rescuing: d.rescuing,
      investigating: d.investigating,
      canShoot: d.canShoot,
      engagementOut: eng,
    },
  };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios.map((s) => `${s.name}=${s.expected.mode}`).join(', ')}`,
  );
}

void main();
