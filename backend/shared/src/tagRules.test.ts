import { describe, expect, it } from 'vitest';
import { canTag, tagRejectionReason, type TagCandidate, type TagContext } from './tagRules.ts';
import { HOVER_HEIGHT, JUMP_AMP } from './physics.ts';
import type { Vec3 } from './protocol.ts';
import type { WallSegment } from './labyrinth.ts';

const at = (x: number, z: number, y: number = HOVER_HEIGHT): Vec3 => ({ x, y, z });

const grounded = (
  team: 'mime' | 'clown',
  x: number,
  z: number,
  y: number = HOVER_HEIGHT,
  frozen = false,
): TagCandidate => ({ team, position: at(x, z, y), frozen });

const baseCtx = (overrides: Partial<TagContext> = {}): TagContext => ({
  victimResolvedPos: at(0, 0),
  phase: 'turn_mime',
  victimSavedAtMs: undefined,
  unfreezeGraceMs: 1500,
  nowMs: 10_000,
  walls: [],
  topology: 'plane',
  worldWidth: 80,
  ...overrides,
});

describe('tagRejectionReason', () => {
  it('accepts a same-turn cross-team tag inside the radius', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 1, 0);
    expect(
      tagRejectionReason(attacker, victim, 1.4, baseCtx({ victimResolvedPos: victim.position })),
    ).toBeNull();
    expect(canTag(attacker, victim, 1.4, baseCtx({ victimResolvedPos: victim.position }))).toBe(
      true,
    );
  });

  it('rejects same-team', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('mime', 1, 0);
    expect(
      tagRejectionReason(attacker, victim, 1.4, baseCtx({ victimResolvedPos: victim.position })),
    ).toBe('same_team');
  });

  it('rejects when the attacker is frozen', () => {
    const attacker = grounded('mime', 0, 0, HOVER_HEIGHT, true);
    const victim = grounded('clown', 1, 0);
    expect(
      tagRejectionReason(attacker, victim, 1.4, baseCtx({ victimResolvedPos: victim.position })),
    ).toBe('you_are_frozen');
  });

  it('rejects when the victim is already frozen', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 1, 0, HOVER_HEIGHT, true);
    expect(
      tagRejectionReason(attacker, victim, 1.4, baseCtx({ victimResolvedPos: victim.position })),
    ).toBe('already_frozen');
  });

  it('rejects outside the attacker team turn', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 1, 0);
    expect(
      tagRejectionReason(
        attacker,
        victim,
        1.4,
        baseCtx({ victimResolvedPos: victim.position, phase: 'turn_clown' }),
      ),
    ).toBe('not_your_turn');
  });

  it('rejects inside the just-saved grace window', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 1, 0);
    expect(
      tagRejectionReason(
        attacker,
        victim,
        1.4,
        baseCtx({
          victimResolvedPos: victim.position,
          victimSavedAtMs: 9_500,
          unfreezeGraceMs: 1500,
          nowMs: 10_000,
        }),
      ),
    ).toBe('just_saved');
  });

  it('accepts a tag once the grace window has elapsed', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 1, 0);
    expect(
      tagRejectionReason(
        attacker,
        victim,
        1.4,
        baseCtx({
          victimResolvedPos: victim.position,
          victimSavedAtMs: 5_000,
          unfreezeGraceMs: 1500,
          nowMs: 10_000,
        }),
      ),
    ).toBeNull();
  });

  it('rejects out of range with the distance in the code', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 5, 0);
    const reason = tagRejectionReason(
      attacker,
      victim,
      1.4,
      baseCtx({ victimResolvedPos: victim.position }),
    );
    expect(reason).toMatch(/^out_of_range:/);
  });

  it('rejects a tag blocked by a wall', () => {
    const wall: WallSegment = { ax: 0.5, az: -1, bx: 0.5, bz: 1 };
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 1, 0);
    expect(
      tagRejectionReason(
        attacker,
        victim,
        1.4,
        baseCtx({ victimResolvedPos: victim.position, walls: [wall] }),
      ),
    ).toBe('wall_in_way');
  });

  it('rejects a peak jumper against a grounded attacker', () => {
    const attacker = grounded('mime', 0, 0);
    const victim = grounded('clown', 1, 0, HOVER_HEIGHT + JUMP_AMP);
    expect(
      tagRejectionReason(attacker, victim, 1.4, baseCtx({ victimResolvedPos: victim.position })),
    ).toBe('vertical_separation');
  });

  it('accepts two synchronized jumpers within the vertical-overlap threshold', () => {
    const attacker = grounded('mime', 0, 0, HOVER_HEIGHT + JUMP_AMP);
    const victim = grounded('clown', 1, 0, HOVER_HEIGHT + JUMP_AMP);
    expect(
      tagRejectionReason(attacker, victim, 1.4, baseCtx({ victimResolvedPos: victim.position })),
    ).toBeNull();
  });
});
