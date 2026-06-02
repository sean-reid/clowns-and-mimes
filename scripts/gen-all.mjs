#!/usr/bin/env node
// Regenerate every generated file from its canonical TS source: all the
// cross-language fixtures (scripts/gen-*-fixture.ts) plus shared_constants.gd.
// CI runs this and then `git diff --exit-code`, so a change to canonical TS
// logic that isn't reflected in the committed GDScript fixture / constants
// fails the build - that's the guard against online/offline drift.
//
// Auto-discovers gen-*-fixture.ts so a newly added fixture is covered without
// editing this file. Each generator runs in its own process (execFileSync waits
// for it to exit, so the async writeFile inside has completed before we move on).
//
// Usage: node scripts/gen-all.mjs   (or `pnpm gen:all`)

import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const tsx = resolve(repoRoot, 'node_modules/.bin/tsx');

const fixtures = (await readdir(here)).filter((f) => /^gen-.*-fixture\.ts$/.test(f)).sort();
if (fixtures.length === 0) throw new Error('no gen-*-fixture.ts scripts found');

for (const file of fixtures) {
  console.log(`\n=== ${file} ===`);
  execFileSync(tsx, [resolve(here, file)], { cwd: repoRoot, stdio: 'inherit' });
}

console.log('\n=== gen-shared-constants.mjs ===');
execFileSync('node', [resolve(here, 'gen-shared-constants.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
});

// The generators write JSON.stringify output; the repo stores the fixtures
// Prettier-formatted (and `pnpm format:check` enforces it). Normalize here so a
// drift check on the result reflects real value changes, not array wrapping.
console.log('\n=== prettier --write (fixtures) ===');
const prettier = resolve(repoRoot, 'node_modules/.bin/prettier');
execFileSync(prettier, ['--write', '--log-level', 'warn', 'game/tests/fixtures'], {
  cwd: repoRoot,
  stdio: 'inherit',
});
