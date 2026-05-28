import { describe, expect, it } from 'vitest';
import {
  HOVER_HEIGHT,
  JUMP_AMP,
  JUMP_COOLDOWN_S,
  JUMP_DURATION_S,
  BODY_VERTICAL_EXTENT,
  jumpArcY,
  isJumping,
  verticallyOverlapping,
} from './physics.ts';
import { resolvePlayerCollisions, stepJump } from './movement.ts';
import type { PlayerState } from './protocol.ts';

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

  it('a peak jumper comfortably evades a grounded body (Option A)', () => {
    // Peak jumper at HOVER_HEIGHT + JUMP_AMP. Grounded at HOVER_HEIGHT.
    // Separation = JUMP_AMP = 2.0 m, comfortably above the 1.4 m
    // BODY_VERTICAL_EXTENT threshold, so the overlap predicate rejects
    // and the tag misses.
    const grounded = at(HOVER_HEIGHT);
    const peak = at(HOVER_HEIGHT + JUMP_AMP);
    expect(verticallyOverlapping(grounded, peak)).toBe(false);
  });
});

describe('stepJump', () => {
  const ARC_MS = JUMP_DURATION_S * 1000;
  const COOLDOWN_MS = JUMP_COOLDOWN_S * 1000;
  const LOCKOUT_MS = ARC_MS + COOLDOWN_MS;

  it('triggers on first jump press', () => {
    const out = stepJump({ jumpStartedAt: null }, { jump: true, nowMs: 1000 });
    expect(out.jumpStartedAt).toBe(1000);
  });

  it('does nothing when jump is false and not in lockout', () => {
    const out = stepJump({ jumpStartedAt: null }, { jump: false, nowMs: 1000 });
    expect(out.jumpStartedAt).toBeNull();
  });

  it('rejects a second jump during the arc', () => {
    const out = stepJump({ jumpStartedAt: 1000 }, { jump: true, nowMs: 1000 + ARC_MS / 2 });
    expect(out.jumpStartedAt).toBe(1000);
  });

  it('rejects a second jump during the cooldown sub-window', () => {
    const out = stepJump(
      { jumpStartedAt: 1000 },
      { jump: true, nowMs: 1000 + ARC_MS + COOLDOWN_MS / 2 },
    );
    expect(out.jumpStartedAt).toBe(1000);
  });

  it('clears jumpStartedAt at the end of the lockout window', () => {
    const out = stepJump({ jumpStartedAt: 1000 }, { jump: false, nowMs: 1000 + LOCKOUT_MS });
    expect(out.jumpStartedAt).toBeNull();
  });

  it('clears + triggers in a single tick when lockout expires and jump is pressed', () => {
    const out = stepJump({ jumpStartedAt: 1000 }, { jump: true, nowMs: 1000 + LOCKOUT_MS + 5 });
    expect(out.jumpStartedAt).toBe(1000 + LOCKOUT_MS + 5);
  });

  it('is deterministic across replays with the same input', () => {
    const a = stepJump({ jumpStartedAt: null }, { jump: true, nowMs: 7777 });
    const b = stepJump({ jumpStartedAt: null }, { jump: true, nowMs: 7777 });
    expect(a).toEqual(b);
  });
});

describe('resolvePlayerCollisions', () => {
  const makePlayer = (
    id: string,
    x: number,
    z: number,
    jumpStartedAt: number | null = null,
    frozen = false,
  ): PlayerState => ({
    id,
    name: id,
    team: 'mime',
    bot: false,
    position: { x, y: HOVER_HEIGHT, z },
    yaw: 0,
    frozen,
    sprintEnergy: 100,
    sprinting: false,
    jumpStartedAt,
  });

  it('does nothing when players are far apart', () => {
    const a = makePlayer('a', 0, 0);
    const b = makePlayer('b', 5, 0);
    const before = { ...a.position };
    resolvePlayerCollisions([a, b], new Map(), 0.0167, [], 'plane', 80, 0);
    expect(a.position).toEqual(before);
  });

  it('pushes overlapping bodies apart', () => {
    const a = makePlayer('a', 0, 0);
    const b = makePlayer('b', 0.5, 0);
    resolvePlayerCollisions([a, b], new Map(), 0.0167, [], 'plane', 80, 0);
    const finalDist = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);
    expect(finalDist).toBeGreaterThanOrEqual(2 * 0.4 - 1e-6);
  });

  it('applies stronger bounce when at least one body is jumping', () => {
    const aGrounded = makePlayer('a', 0, 0);
    const bGrounded = makePlayer('b', 0.5, 0);
    const prevGrounded = new Map([
      ['a', { x: -0.1, z: 0 }],
      ['b', { x: 0.6, z: 0 }],
    ]);
    resolvePlayerCollisions(
      [aGrounded, bGrounded],
      prevGrounded,
      0.0167,
      [],
      'plane',
      80,
      1_000_000,
    );
    const groundedSep = Math.hypot(
      bGrounded.position.x - aGrounded.position.x,
      bGrounded.position.z - aGrounded.position.z,
    );

    const aAerial = makePlayer('a', 0, 0, 1_000_000);
    const bAerial = makePlayer('b', 0.5, 0);
    const prevAerial = new Map([
      ['a', { x: -0.1, z: 0 }],
      ['b', { x: 0.6, z: 0 }],
    ]);
    resolvePlayerCollisions([aAerial, bAerial], prevAerial, 0.0167, [], 'plane', 80, 1_000_000);
    const aerialSep = Math.hypot(
      bAerial.position.x - aAerial.position.x,
      bAerial.position.z - aAerial.position.z,
    );

    expect(aerialSep).toBeGreaterThan(groundedSep);
  });

  it('does not push a frozen body', () => {
    const a = makePlayer('a', 0, 0);
    const b = makePlayer('b', 0.5, 0, null, true);
    const bBefore = { ...b.position };
    resolvePlayerCollisions([a, b], new Map(), 0.0167, [], 'plane', 80, 0);
    expect(b.position).toEqual(bBefore);
    // The non-frozen body takes the full push so they end up separated.
    const finalDist = Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);
    expect(finalDist).toBeGreaterThanOrEqual(2 * 0.4 - 1e-6);
  });

  it('is deterministic across re-runs with the same input', () => {
    const a1 = makePlayer('a', 0, 0);
    const b1 = makePlayer('b', 0.5, 0);
    const a2 = makePlayer('a', 0, 0);
    const b2 = makePlayer('b', 0.5, 0);
    resolvePlayerCollisions([a1, b1], new Map(), 0.0167, [], 'plane', 80, 0);
    resolvePlayerCollisions([a2, b2], new Map(), 0.0167, [], 'plane', 80, 0);
    expect(a1.position).toEqual(a2.position);
    expect(b1.position).toEqual(b2.position);
  });

  it('keeps positions inside the canonical domain when pushed across the seam', () => {
    // A contact at x = +39.8 pushed in the +x direction would otherwise
    // land at +40.2 (outside the [-40, 40) canonical torus domain). Without
    // the post-push wrap, the next tick's stepMovement leaves the extended
    // value untouched when the player input is zero, and the server
    // broadcasts +40.2 forever - the client renders body=+40.2 from
    // _process and body=-39.8 from _physics_process every frame, producing
    // the "two angles" seam camera flicker.
    const a = makePlayer('a', 39.9, 0);
    const b = makePlayer('b', 39.5, 0);
    resolvePlayerCollisions([a, b], new Map(), 0.0167, [], 'torus', 80, 0);
    expect(a.position.x).toBeGreaterThanOrEqual(-40);
    expect(a.position.x).toBeLessThan(40);
    expect(b.position.x).toBeGreaterThanOrEqual(-40);
    expect(b.position.x).toBeLessThan(40);
  });
});
