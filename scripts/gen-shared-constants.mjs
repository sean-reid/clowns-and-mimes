#!/usr/bin/env node
// Generate game/scripts/shared_constants.gd from the canonical TS values
// in backend/shared/src/physics.ts and backend/shared/src/movement.ts.
//
// The TS side stays the source of truth. This script scrapes literal
// numeric `export const` declarations and emits a GDScript file that
// physics.gd / movement.gd / player.gd alias their local consts from.
// Run as part of CI: regenerate, then `git diff --exit-code` to fail if
// anyone hand-edited the generated file.
//
// Usage:
//   node scripts/gen-shared-constants.mjs           # write the file
//   node scripts/gen-shared-constants.mjs --check   # exit 1 if regen differs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/scripts/shared_constants.gd');

// Source files + the constants to pull from each. Anything not listed
// stays local to the file that owns it.
const SOURCES = [
  {
    file: 'backend/shared/src/physics.ts',
    sourceUrl: 'backend/shared/src/physics.ts',
    consts: [
      'HOVER_HEIGHT',
      'JUMP_AMP',
      'LEAP_JUMP_AMP',
      'WALL_HEIGHT',
      'JUMP_DURATION_S',
      'BODY_VERTICAL_EXTENT',
      'JUMP_COOLDOWN_S',
      'BOUNCE_E_GROUNDED',
      'BOUNCE_E_AERIAL',
      'BOUNCE_E_WALL',
      'EYE_HEIGHT',
      'HEAD_CENTER_HEIGHT',
      'HEAD_RADIUS',
    ],
  },
  {
    file: 'backend/shared/src/movement.ts',
    sourceUrl: 'backend/shared/src/movement.ts',
    consts: [
      'WALK_SPEED',
      'SPRINT_SPEED',
      'SURGE_SPEED_MULT',
      'SURGE_DURATION_MS',
      'MAX_SPRINT',
      'SPRINT_DRAIN_PER_S',
      'SPRINT_REGEN_PER_S',
      'SPRINT_ENGAGE_THRESHOLD',
    ],
  },
  {
    file: 'backend/shared/src/projectiles.ts',
    sourceUrl: 'backend/shared/src/projectiles.ts',
    consts: [
      'PROJECTILE_RADIUS',
      'SHOOT_COOLDOWN_MS',
      'PROJECTILE_SPEED',
      'PROJECTILE_LIFETIME_MS',
    ],
  },
  {
    file: 'backend/shared/src/botTuning.ts',
    sourceUrl: 'backend/shared/src/botTuning.ts',
    consts: [
      'TAG_RADIUS_BOT',
      'UNFREEZE_RADIUS_BOT',
      'BOT_VISION_RADIUS',
      'BOT_TARGET_CORNER_WEIGHT',
      'BOT_TARGET_ISOLATION_WEIGHT',
      'BOT_TARGET_CORNER_SAMPLE_DIST',
      'BOT_SHOOT_RANGE',
      'BOT_SHOOT_AIM_JITTER',
      'RETARGET_HYSTERESIS',
      'BOT_INVESTIGATE_MS',
      'BOT_SPRINT_TRIGGER_RADIUS',
      'BOT_FLEE_PROJECTION',
      'DIR_SMOOTHING',
      'MAX_YAW_RATE',
      'BOT_PATROL_RETARGET_MS',
      'BOT_PATROL_CANDIDATE_ATTEMPTS',
      'BOT_NO_PROGRESS_WINDOW_MS',
      'BOT_NO_PROGRESS_MIN_DIST',
      'BOT_RECENT_TARGETS_KEEP',
      'BOT_RECENT_TARGET_RADIUS',
      'BOT_PATROL_VISIT_DECAY_MS',
      'BOT_PATROL_MOMENTUM_BONUS',
      'BOT_PATROL_SPREAD_RADIUS',
      'BOT_PATROL_SPREAD_WEIGHT',
      'BOT_ITEM_SEEK_RADIUS',
      'BOT_JUMP_REFRACTORY_MS',
      'BOT_JUMP_NOISE_PER_SECOND',
      'BOT_JUMP_EVADE_BUFFER',
      'BOT_JUMP_CORNER_THREAT_RADIUS',
      'CLONE_DURATION_MS',
      'CLONE_SPAWN_OFFSET',
      'WALL_AVOID_WEIGHT',
      'WALL_AVOID_RADIUS',
      'OCCUPANCY_WEIGHT',
      'OCCUPANCY_RADIUS',
    ],
  },
  {
    file: 'backend/shared/src/labyrinth.ts',
    sourceUrl: 'backend/shared/src/labyrinth.ts',
    // WALL_CLEARANCE itself is computed (not a literal), so share its literal
    // parts; the GDScript side recombines them.
    consts: ['WALL_THICKNESS', 'PLAYER_RADIUS'],
  },
  {
    file: 'backend/shared/src/items.ts',
    sourceUrl: 'backend/shared/src/items.ts',
    consts: [
      'ITEM_RESPAWN_MS',
      'ITEM_PICKUP_RADIUS',
      'ITEM_SPAWN_KEEP_DENOM',
      'RADAR_DURATION_MS',
      'CLOAK_DURATION_MS',
    ],
  },
  {
    file: 'backend/shared/src/portals.ts',
    sourceUrl: 'backend/shared/src/portals.ts',
    consts: [
      'PORTAL_DURATION_MS',
      'PORTAL_ENTER_RADIUS',
      'PORTAL_EXIT_OFFSET',
      'PORTAL_TELEPORT_COOLDOWN_MS',
      'PORTAL_MOUTH_RADIUS',
    ],
  },
];

// Source files + the string-array `export const`s to pull from each. These
// emit as GDScript PackedStringArray-style array literals.
const STRING_ARRAY_SOURCES = [
  {
    file: 'backend/shared/src/names.ts',
    sourceUrl: 'backend/shared/src/names.ts',
    consts: ['NAME_ADJECTIVES', 'NAME_NOUNS'],
  },
  {
    file: 'backend/shared/src/items.ts',
    sourceUrl: 'backend/shared/src/items.ts',
    consts: ['ITEM_TYPES_ALWAYS', 'ITEM_TYPES_ROTATING'],
  },
];

async function extract(file, name) {
  const text = await readFile(resolve(repoRoot, file), 'utf8');
  // Allow an optional `: Type` annotation between the name and `=`.
  const re = new RegExp(`^export const ${name}\\s*(?::[^=]+)?=\\s*([^;]+);`, 'm');
  const m = text.match(re);
  if (!m) throw new Error(`${file}: missing const ${name}`);
  const expr = m[1].trim();
  // Strip numeric separators (30_000 -> 30000) so the literal parses.
  const value = parseFloat(expr.replace(/_/g, ''));
  if (!Number.isFinite(value)) {
    throw new Error(
      `${file}: ${name} = "${expr}" is not a literal number; only literals can be shared`,
    );
  }
  return { name, expr, value };
}

// Pull a string-array `export const NAME = [ '...', '...' ];` and return the
// list of string entries in source order.
async function extractStringArray(file, name) {
  const text = await readFile(resolve(repoRoot, file), 'utf8');
  const re = new RegExp(`^export const ${name}\\s*(?::[^=]+)?=\\s*\\[([\\s\\S]*?)\\];`, 'm');
  const m = text.match(re);
  if (!m) throw new Error(`${file}: missing string array ${name}`);
  const items = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
  if (items.length === 0) {
    throw new Error(`${file}: ${name} parsed to an empty array`);
  }
  return { name, items };
}

// Emit a GDScript array literal: const NAME := ["a", "b", ...].
function gdStringArray(name, items) {
  const quoted = items.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(', ');
  return `const ${name} := [${quoted}]`;
}

// Format the value the same way regardless of whether the literal was
// "0.5", "100", "2.0", etc. GDScript reads "0.5" and "100" identically;
// staying with parseFloat's String() output keeps the diff small.
function gdLiteral(value) {
  if (Number.isInteger(value)) return value.toFixed(1);
  return String(value);
}

async function generate() {
  const sections = [];
  for (const source of SOURCES) {
    const entries = [];
    for (const name of source.consts) {
      entries.push(await extract(source.file, name));
    }
    sections.push({ source, entries });
  }
  const lines = [
    'extends RefCounted',
    '',
    '## Generated by scripts/gen-shared-constants.mjs from the TS-side',
    '## canonical values. Do NOT hand-edit; CI runs the generator and',
    '## fails the lint job on any diff.',
    '##',
    '## physics.gd / movement.gd / player.gd alias their local consts',
    '## from this file so a single edit in backend/shared/src/*.ts ratchets',
    '## both sides.',
    '',
  ];
  for (const section of sections) {
    lines.push(`# Mirrored from ${section.source.sourceUrl}`);
    for (const entry of section.entries) {
      lines.push(`const ${entry.name} := ${gdLiteral(entry.value)}`);
    }
    lines.push('');
  }
  for (const source of STRING_ARRAY_SOURCES) {
    lines.push(`# Mirrored from ${source.sourceUrl}`);
    for (const name of source.consts) {
      const { items } = await extractStringArray(source.file, name);
      lines.push(gdStringArray(name, items));
    }
    lines.push('');
  }
  return lines.join('\n');
}

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');

const next = await generate();

if (checkOnly) {
  let current = '';
  try {
    current = await readFile(OUTPUT, 'utf8');
  } catch {
    console.error(
      `${OUTPUT} is missing. Run \`node scripts/gen-shared-constants.mjs\` and commit the result.`,
    );
    process.exit(1);
  }
  if (current !== next) {
    console.error(
      `${OUTPUT} is out of date. Run \`node scripts/gen-shared-constants.mjs\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log('shared_constants.gd is in sync.');
} else {
  await writeFile(OUTPUT, next);
  console.log(`wrote ${OUTPUT}`);
}
