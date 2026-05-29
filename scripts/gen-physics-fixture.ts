// Cross-language physics fixture. Pure parabolic jump arc + lockout
// logic. Lower drift risk than movement/topology/gridMaze (no
// accumulation) but cheap to capture and catches a future change to
// the arc formula on one side without the other.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isJumping,
  jumpArcY,
  HOVER_HEIGHT,
  JUMP_AMP,
  JUMP_DURATION_S,
  JUMP_COOLDOWN_S,
} from '../backend/shared/src/physics.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(repoRoot, 'game/tests/fixtures/physics_snapshot.json');

const T_TAKEOFF = 1_700_000_000_000; // arbitrary epoch; we only care about deltas

interface ArcCase {
  label: string;
  startedAtMs: number | null;
  nowMs: number;
  expectedY: number;
}

interface JumpingCase {
  label: string;
  startedAtMs: number | null;
  nowMs: number;
  expectedJumping: boolean;
}

const DURATION_MS = JUMP_DURATION_S * 1000;

// Sample the arc at start, quarter, half (peak), three-quarters, end-1ms,
// past end. Plus the not-jumping null sentinel.
const ARC_CASES: ArcCase[] = [
  {
    label: 'null_sentinel',
    startedAtMs: null,
    nowMs: T_TAKEOFF,
    expectedY: jumpArcY(null, T_TAKEOFF),
  },
  {
    label: 't_0',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF,
    expectedY: jumpArcY(T_TAKEOFF, T_TAKEOFF),
  },
  {
    label: 't_quarter',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS * 0.25,
    expectedY: jumpArcY(T_TAKEOFF, T_TAKEOFF + DURATION_MS * 0.25),
  },
  {
    label: 't_peak',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS * 0.5,
    expectedY: jumpArcY(T_TAKEOFF, T_TAKEOFF + DURATION_MS * 0.5),
  },
  {
    label: 't_three_quarter',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS * 0.75,
    expectedY: jumpArcY(T_TAKEOFF, T_TAKEOFF + DURATION_MS * 0.75),
  },
  {
    label: 't_almost_end',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS - 1,
    expectedY: jumpArcY(T_TAKEOFF, T_TAKEOFF + DURATION_MS - 1),
  },
  {
    label: 't_past_end',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS + 100,
    expectedY: jumpArcY(T_TAKEOFF, T_TAKEOFF + DURATION_MS + 100),
  },
];

const JUMPING_CASES: JumpingCase[] = [
  {
    label: 'null_sentinel',
    startedAtMs: null,
    nowMs: T_TAKEOFF,
    expectedJumping: isJumping({ jumpStartedAt: null }, T_TAKEOFF),
  },
  {
    label: 'fresh_jump',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + 1,
    expectedJumping: isJumping({ jumpStartedAt: T_TAKEOFF }, T_TAKEOFF + 1),
  },
  {
    label: 'mid_arc',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS / 2,
    expectedJumping: isJumping({ jumpStartedAt: T_TAKEOFF }, T_TAKEOFF + DURATION_MS / 2),
  },
  {
    label: 'at_end',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS,
    expectedJumping: isJumping({ jumpStartedAt: T_TAKEOFF }, T_TAKEOFF + DURATION_MS),
  },
  {
    label: 'past_end',
    startedAtMs: T_TAKEOFF,
    nowMs: T_TAKEOFF + DURATION_MS + 1,
    expectedJumping: isJumping({ jumpStartedAt: T_TAKEOFF }, T_TAKEOFF + DURATION_MS + 1),
  },
];

async function main(): Promise<void> {
  const fixture = {
    schemaVersion: 1,
    hoverHeight: HOVER_HEIGHT,
    jumpAmp: JUMP_AMP,
    jumpDurationS: JUMP_DURATION_S,
    jumpCooldownS: JUMP_COOLDOWN_S,
    arcCases: ARC_CASES,
    jumpingCases: JUMPING_CASES,
  };
  await writeFile(OUTPUT, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${OUTPUT}`);
  console.log(`arc cases: ${ARC_CASES.length}, jumping cases: ${JUMPING_CASES.length}`);
}

void main();
