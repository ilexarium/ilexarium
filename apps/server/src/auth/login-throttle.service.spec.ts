import { LoginThrottleService, TooManyAttemptsException } from './login-throttle.service.js';

function setup() {
  let now = 1_000_000;
  const throttle = new LoginThrottleService(() => now);
  return {
    throttle,
    advance: (ms: number) => (now += ms),
    retryAfter: (username: string): number | undefined => {
      try {
        throttle.assertAllowed(username);
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(TooManyAttemptsException);
        return (error as TooManyAttemptsException).retryAfterSeconds;
      }
    },
  };
}

describe('LoginThrottleService', () => {
  it('allows a username with no failures', () => {
    expect(setup().retryAfter('owner')).toBeUndefined();
  });

  it('doubles the delay from 1 s with each failure', () => {
    const { throttle, retryAfter, advance } = setup();
    const delays: (number | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      throttle.recordFailure('owner');
      delays.push(retryAfter('owner'));
      advance(60_000); // wait out the delay before the next attempt
    }
    expect(delays).toEqual([1, 2, 4, 8, 16]);
  });

  it('caps the delay at 60 s (a delay, never a lockout)', () => {
    const { throttle, retryAfter, advance } = setup();
    for (let i = 0; i < 20; i++) {
      throttle.recordFailure('owner');
      advance(60_000);
    }
    throttle.recordFailure('owner');
    expect(retryAfter('owner')).toBe(60);
    advance(60_000);
    expect(retryAfter('owner')).toBeUndefined();
  });

  it('allows again once the delay has passed', () => {
    const { throttle, retryAfter, advance } = setup();
    throttle.recordFailure('owner');
    advance(999);
    expect(retryAfter('owner')).toBe(1);
    advance(1);
    expect(retryAfter('owner')).toBeUndefined();
  });

  it('resets on success', () => {
    const { throttle, retryAfter, advance } = setup();
    for (let i = 0; i < 4; i++) throttle.recordFailure('owner');
    throttle.reset('owner');
    expect(retryAfter('owner')).toBeUndefined();
    throttle.recordFailure('owner');
    expect(retryAfter('owner')).toBe(1);
    advance(1_000);
  });

  it('keeps usernames independent', () => {
    const { throttle, retryAfter } = setup();
    throttle.recordFailure('attacker-target');
    expect(retryAfter('owner')).toBeUndefined();
  });

  it('forgets a username 15 minutes after its last failure', () => {
    const { throttle, retryAfter, advance } = setup();
    for (let i = 0; i < 5; i++) throttle.recordFailure('owner');
    advance(15 * 60_000 + 1);
    expect(retryAfter('owner')).toBeUndefined();
    throttle.recordFailure('owner');
    expect(retryAfter('owner')).toBe(1); // counting starts over
  });

  it('stays bounded when many usernames are tried', () => {
    const { throttle } = setup();
    for (let i = 0; i < 10_050; i++) throttle.recordFailure(`random-${i}`);
    expect(throttle.size).toBe(10_000);
  });

  it('evicts the least recently failed usernames first', () => {
    const { throttle, retryAfter } = setup();
    throttle.recordFailure('owner');
    for (let i = 0; i < 9_999; i++) throttle.recordFailure(`random-${i}`);
    throttle.recordFailure('owner'); // refreshed: now the most recent
    throttle.recordFailure('one-more');
    expect(retryAfter('owner')).toBe(2);
  });
});
