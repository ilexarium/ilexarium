import { MessageRateLimiter } from './message-rate-limiter.js';

describe('MessageRateLimiter', () => {
  let now = 0;
  const limiter = () => new MessageRateLimiter(3, 1000, () => now);
  const hits = (l: MessageRateLimiter, count: number) =>
    Array.from({ length: count }, () => l.hit());

  beforeEach(() => {
    now = 0;
  });

  it('allows up to the limit, then limits, then calls it abusive at twice the limit', () => {
    expect(hits(limiter(), 7)).toEqual([
      'allowed',
      'allowed',
      'allowed',
      'limited',
      'limited',
      'limited',
      'abusive',
    ]);
  });

  it('allows again once old messages leave the window', () => {
    const l = limiter();
    hits(l, 3);
    now = 999;
    expect(l.hit()).toBe('limited');
    now = 1000; // the first three are out of the window; the limited one at 999 is not
    expect(hits(l, 3)).toEqual(['allowed', 'allowed', 'limited']);
  });

  it('keeps no more than the window in memory', () => {
    const l = limiter();
    for (let i = 0; i < 1000; i++) {
      now = i * 1000;
      expect(l.hit()).toBe('allowed');
    }
  });
});
