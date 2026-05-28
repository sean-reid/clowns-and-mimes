// Generate a JSON fixture of stepMovement outputs and write it to
// game/tests/fixtures/movement_snapshot.json. The GDScript runner reads
// the same file and asserts byte-equivalent results from Movement.step
// in lockstep with the TS authoritative implementation.
//
// Run via `pnpm gen:movement-fixture`. CI runs the same generator and
// `git diff --exit-code`s the file so any TS-side change without a
// regenerate (or any client-side divergence on the next regen) fails.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stepMovement,
  type MoveStepState,
  type MoveStepInput,
} from '../backend/shared/src/movement.ts';
import { HOVER_HEIGHT } from '../backend/shared/src/physics.ts';
import type { WallSegment } from '../backend/shared/src/labyrinth.ts';
import type { Topology } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/movement_snapshot.json');

const TICK = 1 / 60;
const WORLD_WIDTH = 80;
const noOtherBodies = () => false;

interface Scenario {
  name: string;
  topology: Topology;
  walls: WallSegment[];
  initial: {
    position: { x: number; y: number; z: number };
    sprintEnergy: number;
    sprinting: boolean;
  };
  input: { move: { x: number; z: number }; sprint: boolean; dt: number };
  ticks: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'walk_plus_x_plane_60_ticks',
    topology: 'plane',
    walls: [],
    initial: { position: { x: 0, y: HOVER_HEIGHT, z: 0 }, sprintEnergy: 100, sprinting: false },
    input: { move: { x: 1, z: 0 }, sprint: false, dt: TICK },
    ticks: 60,
  },
  {
    name: 'sprint_plus_z_to_depletion',
    topology: 'plane',
    walls: [],
    initial: { position: { x: 0, y: HOVER_HEIGHT, z: 0 }, sprintEnergy: 100, sprinting: false },
    input: { move: { x: 0, z: 1 }, sprint: true, dt: TICK },
    ticks: 240,
  },
  {
    name: 'wall_rebound',
    topology: 'plane',
    walls: [{ ax: 0.5, az: -2, bx: 0.5, bz: 2 }],
    initial: { position: { x: 0, y: HOVER_HEIGHT, z: 0 }, sprintEnergy: 100, sprinting: false },
    input: { move: { x: 1, z: 0 }, sprint: false, dt: TICK },
    ticks: 5,
  },
  {
    name: 'torus_plus_x_seam_wrap',
    topology: 'torus',
    walls: [],
    initial: { position: { x: 39, y: HOVER_HEIGHT, z: 0 }, sprintEnergy: 100, sprinting: false },
    input: { move: { x: 1, z: 0 }, sprint: true, dt: TICK },
    ticks: 300,
  },
  {
    name: 'idle_sprint_regen',
    topology: 'plane',
    walls: [],
    initial: { position: { x: 5, y: HOVER_HEIGHT, z: 5 }, sprintEnergy: 80, sprinting: false },
    input: { move: { x: 0, z: 0 }, sprint: false, dt: TICK },
    ticks: 60,
  },
];

interface ScenarioResult {
  name: string;
  topology: Topology;
  walls: WallSegment[];
  initial: Scenario['initial'];
  input: MoveStepInput;
  ticks: number;
  final: {
    position: { x: number; y: number; z: number };
    sprintEnergy: number;
    sprinting: boolean;
  };
}

function runScenario(s: Scenario): ScenarioResult {
  let state: MoveStepState = {
    position: { ...s.initial.position },
    sprintEnergy: s.initial.sprintEnergy,
    sprinting: s.initial.sprinting,
  };
  for (let i = 0; i < s.ticks; i += 1) {
    state = stepMovement(state, s.input, s.walls, s.topology, WORLD_WIDTH, noOtherBodies);
  }
  return {
    name: s.name,
    topology: s.topology,
    walls: s.walls,
    initial: s.initial,
    input: s.input,
    ticks: s.ticks,
    final: {
      position: state.position,
      sprintEnergy: state.sprintEnergy,
      sprinting: state.sprinting,
    },
  };
}

async function main(): Promise<void> {
  const results = SCENARIOS.map(runScenario);
  const fixture = {
    // Schema version; bump when the shape changes so the GDScript reader
    // can fail fast on stale on-disk fixtures.
    schemaVersion: 1,
    worldWidth: WORLD_WIDTH,
    hoverHeight: HOVER_HEIGHT,
    scenarios: results,
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(`scenarios: ${results.map((r) => r.name).join(', ')}`);
}

void main();
