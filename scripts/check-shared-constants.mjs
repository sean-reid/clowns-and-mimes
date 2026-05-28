#!/usr/bin/env node
// Drift check for the gameplay constants that MUST stay bit-identical
// between the TS shared library and the GDScript client. Reads literal
// numeric constants from both sides and compares.
//
// Intentionally narrow: only flat numeric literals. Derived values like
// `SPRINT_SPEED * 1.5` are skipped because parsing GDScript expressions
// safely is more work than this drift check is worth - the leaf values
// they reference are themselves checked, so a drift on a leaf still
// trips the test.
//
// Run from anywhere; paths are repo-relative via fileURLToPath.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PAIRS = [
  {
    ts: 'backend/shared/src/physics.ts',
    gd: 'game/scripts/physics.gd',
    constants: [
      'HOVER_HEIGHT',
      'JUMP_AMP',
      'JUMP_DURATION_S',
      'BODY_VERTICAL_EXTENT',
      'JUMP_COOLDOWN_S',
      'BOUNCE_E_GROUNDED',
      'BOUNCE_E_AERIAL',
      'BOUNCE_E_WALL',
    ],
  },
  {
    ts: 'backend/shared/src/movement.ts',
    gd: 'game/scripts/movement.gd',
    constants: [
      'WALK_SPEED',
      'SPRINT_SPEED',
      'MAX_SPRINT',
      'SPRINT_DRAIN_PER_S',
      'SPRINT_REGEN_PER_S',
      'SPRINT_ENGAGE_THRESHOLD',
    ],
  },
];

async function extractTs(path, name) {
  const text = await readFile(resolve(repoRoot, path), 'utf8');
  const re = new RegExp(`^export const ${name}\\s*=\\s*([^;]+);`, 'm');
  const m = text.match(re);
  if (!m) throw new Error(`${path}: missing TS const ${name}`);
  const value = parseFloat(m[1].trim());
  if (!Number.isFinite(value)) throw new Error(`${path}: ${name} = "${m[1].trim()}" is not a literal number`);
  return value;
}

async function extractGd(path, name) {
  const text = await readFile(resolve(repoRoot, path), 'utf8');
  const re = new RegExp(`^const ${name}\\s*:?=\\s*(.+)$`, 'm');
  const m = text.match(re);
  if (!m) throw new Error(`${path}: missing GD const ${name}`);
  const value = parseFloat(m[1].trim());
  if (!Number.isFinite(value)) throw new Error(`${path}: ${name} = "${m[1].trim()}" is not a literal number`);
  return value;
}

let failures = 0;
for (const pair of PAIRS) {
  for (const name of pair.constants) {
    try {
      const tsVal = await extractTs(pair.ts, name);
      const gdVal = await extractGd(pair.gd, name);
      // Strict equality. JS parseFloat normalises 0.5 vs 0.5000 vs 1/2-free
      // literals, but expressions like "SPRINT_SPEED * 1.5" produce NaN
      // upstream and are rejected by extract.
      if (tsVal !== gdVal) {
        console.error(`DRIFT  ${name}: ${pair.ts}=${tsVal}  ${pair.gd}=${gdVal}`);
        failures += 1;
      } else {
        console.log(`OK     ${name} = ${tsVal}`);
      }
    } catch (err) {
      console.error(`ERROR  ${name}: ${err.message}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} drift(s) found. Update both files together.`);
  process.exit(1);
}
console.log('\nAll shared constants agree.');
