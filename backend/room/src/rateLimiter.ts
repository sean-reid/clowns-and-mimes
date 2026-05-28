// Per-WebSocket token-bucket rate limiter. Defends against a flooding
// client (malicious or buggy) burning CPU on JSON.parse + handler
// dispatch faster than the simulation can drain inputs. The existing
// MAX_INPUT_QUEUE cap throttles after parse + after the per-tick
// simulation reads; this stops messages at the door before the parse
// runs.
//
// Time source is injectable so tests don't have to sleep.

export interface RateLimiterOptions {
  // Max burst size. Tokens refill toward this number.
  readonly capacity: number;
  // Tokens added per millisecond. capacity / refillPerMs = window in ms.
  readonly refillPerMs: number;
  // Wall clock provider. Default Date.now; tests override.
  readonly now?: () => number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefillAt: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerMs;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.capacity;
    this.lastRefillAt = this.now();
  }

  /**
   * Consume one token if available. Returns true when the caller
   * may proceed, false when the bucket is empty.
   */
  tryConsume(): boolean {
    const t = this.now();
    const elapsed = t - this.lastRefillAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefillAt = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
