import type { RateDecision } from './realtime.model.js';

/** One connection's messages in a sliding window. Refused messages count too. */
export class MessageRateLimiter {
  private hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(): RateDecision {
    const now = this.now();
    this.hits = this.hits.filter((at) => now - at < this.windowMs);
    this.hits.push(now);
    if (this.hits.length <= this.limit) return 'allowed';
    return this.hits.length <= 2 * this.limit ? 'limited' : 'abusive';
  }
}
