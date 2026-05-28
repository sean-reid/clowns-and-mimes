// Cross-language topology fixture. Generates wrap and distance results
// from the canonical TS topology functions for representative points
// across all 4 topologies. The GDScript test reads the JSON and asserts
// the same outputs from the per-topology adapters in
// game/scripts/topology/.
//
// Distance feeds tag radius checks on both sides; wrap defines the
// canonical domain. A drift on Möbius/Klein (the non-orientable
// topologies with subtle seam rules) is the highest-risk class to
// fixture beyond gridMaze.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topologyDistance, wrapPosition, WORLD_WIDTH } from '../backend/shared/src/topology.ts';
import type { Topology, Vec2 } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/topology_snapshot.json');

// Spread points across the canonical domain plus a few near the seams
// where wrap matters. (39.9, ±X) catches the +x seam crossing; (-40, …)
// catches the -x seam; off-center y catches Klein's z-mirror flip.
const POINTS: Vec2[] = [
  { x: 0, z: 0 },
  { x: 10, z: 10 },
  { x: -5, z: 20 },
  { x: 39.9, z: 0 },
  { x: 40.5, z: 0 }, // outside canonical domain
  { x: -40.5, z: 5 }, // outside canonical domain
  { x: 0, z: 39.9 },
  { x: 41, z: 41 }, // both axes outside
  { x: -42, z: -38 },
  { x: 20, z: -20 },
];

const PAIRS: Array<[Vec2, Vec2]> = [
  [POINTS[0]!, POINTS[1]!],
  [POINTS[3]!, { x: -39.9, z: 0 }], // straddles the +x seam (close via wrap, far via Euclidean)
  [POINTS[6]!, { x: 0, z: -39.9 }], // straddles the +z seam
  [POINTS[2]!, POINTS[7]!],
  [
    { x: 39.9, z: 39.9 },
    { x: -39.9, z: -39.9 },
  ], // antipodal on torus
  [POINTS[0]!, POINTS[9]!],
];

const TOPOLOGIES: Topology[] = ['plane', 'torus', 'mobius', 'klein'];

async function main(): Promise<void> {
  const fixture = {
    schemaVersion: 1,
    worldWidth: WORLD_WIDTH,
    scenarios: TOPOLOGIES.map((topology) => ({
      topology,
      wrapTests: POINTS.map((p) => ({
        input: p,
        expected: wrapPosition(p, topology, WORLD_WIDTH),
      })),
      distanceTests: PAIRS.map(([a, b]) => ({
        a,
        b,
        expected: topologyDistance(a, b, topology, WORLD_WIDTH),
      })),
    })),
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  const summary = fixture.scenarios
    .map((s) => `${s.topology}: wrap=${s.wrapTests.length} dist=${s.distanceTests.length}`)
    .join(', ');
  console.log(summary);
}

void main();
