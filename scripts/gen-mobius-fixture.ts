// Cross-language fixture for stepAcrossMobiusBoundary. Drives the canonical
// TS function through a representative set of (prev, next) pairs and writes
// the expected outputs to JSON for the GDScript test to replay against
// MobiusTopology.wrap_step.
//
// stepAcrossMobiusBoundary is the only step-aware wrap in the codebase:
// it rejects motion that crosses the strip's hard z bounds (returning
// prev unchanged so the caller's wall clip takes over) and wraps x
// modular at 2 * MOBIUS_HALF_X without a z-flip - the flip lives in the
// maze geometry, not in the wrap. Drift between TS and GDScript on this
// path would let the client predict a wrap the server rejected (or
// vice versa) and surface as snap-back jitter near the seam.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOBIUS_HALF_X,
  MOBIUS_HALF_Z,
  stepAcrossMobiusBoundary,
} from '../backend/shared/src/mobius.ts';
import type { Vec2 } from '../backend/shared/src/protocol.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/mobius_snapshot.json');

// Step pairs targeting the failure modes the function actually has:
//   - interior motion: passes through unchanged
//   - +x seam crossing: x must wrap to the -x side, z untouched
//   - -x seam crossing: mirror of the above
//   - past the +z bound: motion rejected, prev returned
//   - past the -z bound: motion rejected, prev returned
//   - at the +z bound exactly (within 1e-6 tolerance): accepted
//   - simultaneous x wrap + z still in-bounds: x wraps cleanly
//   - tiny sub-pixel motion: precision check
const STEP_TESTS: Array<{ name: string; prev: Vec2; next: Vec2 }> = [
  {
    name: 'interior motion passes through',
    prev: { x: 0, z: 0 },
    next: { x: 5, z: -3 },
  },
  {
    name: '+x seam wrap, z mid-strip',
    prev: { x: MOBIUS_HALF_X - 0.5, z: 4 },
    next: { x: MOBIUS_HALF_X + 0.5, z: 4 },
  },
  {
    name: '-x seam wrap, z mid-strip',
    prev: { x: -(MOBIUS_HALF_X - 0.5), z: -7 },
    next: { x: -(MOBIUS_HALF_X + 0.5), z: -7 },
  },
  {
    name: 'past +z bound, motion rejected',
    prev: { x: 10, z: MOBIUS_HALF_Z - 0.1 },
    next: { x: 12, z: MOBIUS_HALF_Z + 0.5 },
  },
  {
    name: 'past -z bound, motion rejected',
    prev: { x: -10, z: -(MOBIUS_HALF_Z - 0.1) },
    next: { x: -12, z: -(MOBIUS_HALF_Z + 0.5) },
  },
  {
    name: 'at +z bound within tolerance, accepted',
    prev: { x: 0, z: MOBIUS_HALF_Z - 0.2 },
    next: { x: 1, z: MOBIUS_HALF_Z },
  },
  {
    name: 'at -z bound within tolerance, accepted',
    prev: { x: 0, z: -(MOBIUS_HALF_Z - 0.2) },
    next: { x: -1, z: -MOBIUS_HALF_Z },
  },
  {
    name: '+x seam wrap with negative z',
    prev: { x: MOBIUS_HALF_X - 0.25, z: -15 },
    next: { x: MOBIUS_HALF_X + 0.25, z: -15 },
  },
  {
    name: 'large jump past the seam, multi-wrap',
    prev: { x: 0, z: 0 },
    next: { x: 2 * MOBIUS_HALF_X + 5, z: 0 },
  },
  {
    name: 'sub-pixel motion near the seam',
    prev: { x: MOBIUS_HALF_X - 1e-3, z: 0 },
    next: { x: MOBIUS_HALF_X + 1e-3, z: 0 },
  },
];

async function main(): Promise<void> {
  const fixture = {
    schemaVersion: 1,
    mobiusHalfX: MOBIUS_HALF_X,
    mobiusHalfZ: MOBIUS_HALF_Z,
    stepTests: STEP_TESTS.map((t) => ({
      name: t.name,
      prev: t.prev,
      next: t.next,
      expected: stepAcrossMobiusBoundary(t.prev, t.next),
    })),
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(`stepTests=${fixture.stepTests.length}`);
}

void main();
