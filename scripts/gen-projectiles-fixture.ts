// Cross-language projectile fixture. Runs the canonical TS spawnProjectile +
// stepProjectiles over fixed scenarios (a few flight ticks each) and records
// the survivor positions + hits, to game/tests/fixtures/projectiles_snapshot.json.
// The GDScript test replays each and asserts OfflineProjectiles produces the
// same survivors (positions) and hits (victim ids / terminations).
//
// Run via `pnpm gen:projectiles-fixture`. A divergence means a shot that lands
// online would miss offline (or vice versa).

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  spawnProjectile,
  stepProjectiles,
  PROJECTILE_HIT_RADIUS,
  type ProjectileTarget,
} from '../backend/shared/src/projectiles.ts';
import { generateGridMazeWalls } from '../backend/shared/src/gridMaze.ts';
import type { Projectile, Team, Topology, Vec3 } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/projectiles_snapshot.json');

const DT = 1 / 60;
const TICKS = 30;

interface Scenario {
  name: string;
  topology: Topology;
  seed: number;
  owner: { id: string; team: Team; position: Vec3 };
  dir: Vec3;
  targets: ProjectileTarget[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'plane_hit_enemy',
    topology: 'plane',
    seed: -1, // no walls
    owner: { id: 'shooter', team: 'mime', position: { x: 0, y: 0.5, z: 0 } },
    dir: { x: 1, y: 0, z: 0 },
    // Head center at y = 0.5 + HEAD_CENTER_HEIGHT; place the enemy on the eye-ray.
    targets: [{ id: 'enemy', team: 'clown', position: { x: 6, y: 0.5, z: 0 }, frozen: false }],
  },
  {
    name: 'plane_miss_high',
    topology: 'plane',
    seed: -1,
    owner: { id: 'shooter', team: 'mime', position: { x: 0, y: 0.5, z: 0 } },
    dir: { x: 1, y: 0, z: 0 },
    // Enemy off to the side: clean miss, projectile flies on / expires.
    targets: [{ id: 'enemy', team: 'clown', position: { x: 6, y: 0.5, z: 6 }, frozen: false }],
  },
  {
    name: 'plane_skip_frozen_and_friendly',
    topology: 'plane',
    seed: -1,
    owner: { id: 'shooter', team: 'mime', position: { x: 0, y: 0.5, z: 0 } },
    dir: { x: 1, y: 0, z: 0 },
    targets: [
      { id: 'ally', team: 'mime', position: { x: 4, y: 0.5, z: 0 }, frozen: false },
      { id: 'frozen', team: 'clown', position: { x: 6, y: 0.5, z: 0 }, frozen: true },
      { id: 'live', team: 'clown', position: { x: 9, y: 0.5, z: 0 }, frozen: false },
    ],
  },
  {
    name: 'maze_wall_stop',
    topology: 'plane',
    seed: 12345,
    owner: { id: 'shooter', team: 'mime', position: { x: -36, y: 0.5, z: -36 } },
    dir: { x: 1, y: 0, z: 1 },
    targets: [],
  },
];

function runScenario(s: Scenario) {
  const walls = s.seed < 0 ? [] : generateGridMazeWalls(s.seed, s.topology);
  const first = spawnProjectile(s.owner, s.dir, 'p0', 0, 0);
  let live: Projectile[] = first ? [first] : [];
  const allHits: ReturnType<typeof stepProjectiles>['hits'] = [];
  const frames: Array<Array<{ x: number; y: number; z: number }>> = [];
  for (let i = 0; i < TICKS && live.length > 0; i += 1) {
    const result = stepProjectiles(live, s.targets, {
      dt: DT,
      nowMs: i * 1000 * DT,
      walls,
      topology: s.topology,
      worldWidth: 80,
      hitRadius: PROJECTILE_HIT_RADIUS,
      savedAt: () => undefined,
      unfreezeGraceMs: 0,
    });
    allHits.push(...result.hits);
    live = result.survivors;
    frames.push(live.map((p) => ({ x: p.position.x, y: p.position.y, z: p.position.z })));
  }
  return {
    name: s.name,
    topology: s.topology,
    seed: s.seed,
    owner: s.owner,
    dir: s.dir,
    targets: s.targets,
    finalFrame: frames.length > 0 ? frames[frames.length - 1] : [],
    ticksLived: frames.length,
    hits: allHits,
  };
}

async function main(): Promise<void> {
  const fixture = { schemaVersion: 1, dt: DT, ticks: TICKS, scenarios: SCENARIOS.map(runScenario) };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(
    `scenarios: ${fixture.scenarios.map((s) => `${s.name}(${s.hits.length}h,${s.ticksLived}t)`).join(', ')}`,
  );
}

void main();
