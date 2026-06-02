// Cross-language bot-items fixture. Runs the canonical TS decideItemUse over a
// spend/hold scenario per power-up and writes the decisions to
// game/tests/fixtures/bot_items_snapshot.json. The GDScript test replays each
// and asserts BotItems.decide_item_use returns the same use flag + radar memory
// seed. Deterministic (pure policy, no RNG), so a mismatch is a logic divergence.
//
// Run via `pnpm gen:bot-items-fixture`.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideItemUse, type ItemContext, type ItemParams } from '../backend/room/src/botItems.ts';
import type { ItemType } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/bot_items_snapshot.json');

const PARAMS: ItemParams = {
  sprintTriggerRadius: 10,
  maxSprint: 100,
  tagRadius: 1.4,
  jumpEvadeBuffer: 0.5,
};

const base: ItemContext = {
  chasing: false,
  fleeing: false,
  wantJump: false,
  canShoot: false,
  enemyDist: 999,
  sprintEnergy: 100,
  hasActionableEnemy: false,
  nearestEnemyPos: null,
};

interface Scenario {
  name: string;
  item: ItemType | undefined;
  ctx: ItemContext;
}

const ping = { x: 12, z: -7 };

const SCENARIOS: Scenario[] = [
  { name: 'none', item: undefined, ctx: base },
  { name: 'radar_hold_has_enemy', item: 'radar', ctx: { ...base, hasActionableEnemy: true } },
  { name: 'radar_hold_no_enemy', item: 'radar', ctx: { ...base, nearestEnemyPos: null } },
  {
    name: 'radar_spend_seeds',
    item: 'radar',
    ctx: { ...base, hasActionableEnemy: false, nearestEnemyPos: ping },
  },
  { name: 'leap_spend', item: 'leap', ctx: { ...base, wantJump: true } },
  { name: 'leap_hold', item: 'leap', ctx: { ...base, wantJump: false } },
  {
    name: 'surge_spend',
    item: 'surge',
    ctx: { ...base, chasing: true, enemyDist: 6, sprintEnergy: 40 },
  },
  {
    name: 'surge_hold_high_energy',
    item: 'surge',
    ctx: { ...base, chasing: true, enemyDist: 6, sprintEnergy: 80 },
  },
  {
    name: 'surge_hold_far',
    item: 'surge',
    ctx: { ...base, fleeing: true, enemyDist: 14, sprintEnergy: 10 },
  },
  { name: 'overcharge_spend', item: 'overcharge', ctx: { ...base, canShoot: true } },
  { name: 'overcharge_hold', item: 'overcharge', ctx: { ...base, canShoot: false } },
  { name: 'cloak_spend', item: 'cloak', ctx: { ...base, fleeing: true, enemyDist: 8 } },
  { name: 'cloak_hold_far', item: 'cloak', ctx: { ...base, fleeing: true, enemyDist: 12 } },
  { name: 'cloak_hold_not_fleeing', item: 'cloak', ctx: { ...base, chasing: true, enemyDist: 4 } },
  { name: 'clone_spend_chase', item: 'clone', ctx: { ...base, chasing: true } },
  { name: 'clone_hold_idle', item: 'clone', ctx: base },
  { name: 'portal_spend', item: 'portal', ctx: { ...base, fleeing: true, enemyDist: 2 } },
  { name: 'portal_hold_far', item: 'portal', ctx: { ...base, fleeing: true, enemyDist: 8 } },
];

function run(s: Scenario) {
  const d = decideItemUse(s.item, s.ctx, PARAMS);
  return {
    name: s.name,
    item: s.item ?? null,
    ctx: s.ctx,
    expected: { use: d.use, memorySeed: d.memorySeed },
  };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, params: PARAMS, scenarios: SCENARIOS.map(run) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios.map((s) => `${s.name}=${s.expected.use ? 'use' : 'hold'}`).join(', ')}`,
  );
}

void main();
