import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimiter.ts';

function clock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('allows up to capacity in a burst, then rejects', () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 3, refillPerMs: 0, now: c.now });
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it('refills over time at refillPerMs', () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 2, refillPerMs: 0.01, now: c.now });
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
    // 0.01 tokens/ms * 100ms = 1 token regenerated.
    c.advance(100);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it('caps refill at capacity (no infinite bucket growth)', () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 2, refillPerMs: 1, now: c.now });
    // Drain.
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    // Wait long enough to regen many tokens at this rate.
    c.advance(10_000);
    // Should only have capacity (2), not 10_000 tokens.
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it('sustained rate equals refillPerMs * 1000 per second', () => {
    const c = clock();
    // 60 tokens/sec sustained = 0.06 / ms. Capacity 120 burst.
    const rl = new RateLimiter({ capacity: 120, refillPerMs: 0.06, now: c.now });
    let accepted = 0;
    // Burst 120, then steady stream at 1ms intervals for 1s = 1000 more.
    for (let i = 0; i < 120; i += 1) if (rl.tryConsume()) accepted += 1;
    expect(accepted).toBe(120);
    accepted = 0;
    for (let i = 0; i < 1000; i += 1) {
      c.advance(1);
      if (rl.tryConsume()) accepted += 1;
    }
    // Over 1000ms with 0.06 tokens/ms refill, 60 tokens land. Accept count
    // should be exactly 60 (each tryConsume gates on a whole token).
    expect(accepted).toBe(60);
  });
});
