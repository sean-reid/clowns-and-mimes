import { describe, expect, it } from 'vitest';
import {
  HOVER_HEIGHT,
  JUMP_AMP,
  JUMP_DURATION_S,
  BODY_VERTICAL_EXTENT,
  jumpArcY,
  isJumping,
  verticallyOverlapping,
} from './physics.ts';

const ARC_MS = JUMP_DURATION_S * 1000;

describe('jumpArcY', () => {
  it('returns HOVER_HEIGHT when not jumping', () => {
    expect(jumpArcY(null, 0)).toBe(HOVER_HEIGHT);
    expect(jumpArcY(null, 1_000_000)).toBe(HOVER_HEIGHT);
  });

  it('returns HOVER_HEIGHT at t=0 and t=1', () => {
    expect(jumpArcY(1000, 1000)).toBe(HOVER_HEIGHT);
    expect(jumpArcY(1000, 1000 + ARC_MS)).toBe(HOVER_HEIGHT);
  });

  it('returns HOVER_HEIGHT + JUMP_AMP at the peak (t=0.5)', () => {
    expect(jumpArcY(1000, 1000 + ARC_MS / 2)).toBeCloseTo(HOVER_HEIGHT + JUMP_AMP, 6);
  });

  it('is symmetric around the peak', () => {
    const earlier = jumpArcY(0, 0.25 * ARC_MS);
    const later = jumpArcY(0, 0.75 * ARC_MS);
    expect(earlier).toBeCloseTo(later, 6);
  });

  it('clamps before the jump start and after the arc window', () => {
    expect(jumpArcY(1000, 999)).toBe(HOVER_HEIGHT);
    expect(jumpArcY(1000, 1000 + ARC_MS + 1)).toBe(HOVER_HEIGHT);
    expect(jumpArcY(1000, 1000 + 10 * ARC_MS)).toBe(HOVER_HEIGHT);
  });

  it('produces y > HOVER_HEIGHT strictly inside the arc window', () => {
    for (const f of [0.01, 0.1, 0.3, 0.7, 0.9, 0.99]) {
      expect(jumpArcY(0, f * ARC_MS)).toBeGreaterThan(HOVER_HEIGHT);
    }
  });
});

describe('isJumping', () => {
  it('is false when jumpStartedAt is null', () => {
    expect(isJumping({ jumpStartedAt: null }, 1000)).toBe(false);
  });

  it('is true during the arc window', () => {
    expect(isJumping({ jumpStartedAt: 1000 }, 1000)).toBe(true);
    expect(isJumping({ jumpStartedAt: 1000 }, 1000 + ARC_MS / 2)).toBe(true);
    expect(isJumping({ jumpStartedAt: 1000 }, 1000 + ARC_MS - 1)).toBe(true);
  });

  it('is false once the arc window expires', () => {
    expect(isJumping({ jumpStartedAt: 1000 }, 1000 + ARC_MS)).toBe(false);
    expect(isJumping({ jumpStartedAt: 1000 }, 1000 + ARC_MS + 1000)).toBe(false);
  });
});

describe('verticallyOverlapping', () => {
  const at = (y: number) => ({ position: { x: 0, y, z: 0 } });

  it('returns true at the same height', () => {
    expect(verticallyOverlapping(at(HOVER_HEIGHT), at(HOVER_HEIGHT))).toBe(true);
  });

  it('returns true just under the threshold', () => {
    expect(verticallyOverlapping(at(0), at(BODY_VERTICAL_EXTENT - 0.001))).toBe(true);
  });

  it('returns false at or past the threshold', () => {
    expect(verticallyOverlapping(at(0), at(BODY_VERTICAL_EXTENT))).toBe(false);
    expect(verticallyOverlapping(at(0), at(BODY_VERTICAL_EXTENT + 0.001))).toBe(false);
  });

  it('is symmetric in argument order', () => {
    const lo = at(0);
    const hi = at(BODY_VERTICAL_EXTENT - 0.001);
    expect(verticallyOverlapping(lo, hi)).toBe(verticallyOverlapping(hi, lo));
  });

  it('a peak jumper just barely evades a grounded body (Option A boundary)', () => {
    // Peak jumper at HOVER_HEIGHT + JUMP_AMP. Grounded at HOVER_HEIGHT.
    // Separation is exactly JUMP_AMP. BODY_VERTICAL_EXTENT is tuned to be
    // just below JUMP_AMP, so the overlap predicate must return false.
    const grounded = at(HOVER_HEIGHT);
    const peak = at(HOVER_HEIGHT + JUMP_AMP);
    expect(verticallyOverlapping(grounded, peak)).toBe(false);
  });
});
