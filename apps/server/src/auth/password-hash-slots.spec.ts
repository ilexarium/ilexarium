import { ANONYMOUS_HASHES_AT_ONCE } from './auth.constants.js';
import { TooManyAttemptsException } from './login-throttle.service.js';
import { PasswordHashSlots } from './password-hash-slots.js';

describe('PasswordHashSlots', () => {
  it('runs a few checks at once; one more is refused at once (429) without running', async () => {
    const slots = new PasswordHashSlots();
    const finish: (() => void)[] = [];
    const running = Array.from({ length: ANONYMOUS_HASHES_AT_ONCE }, () =>
      slots.run(() => new Promise<string>((resolve) => finish.push(() => resolve('done')))),
    );
    const extra = vi.fn(async () => 'never');
    await expect(slots.run(extra)).rejects.toBeInstanceOf(TooManyAttemptsException);
    expect(extra).not.toHaveBeenCalled();
    finish.forEach((done) => done());
    expect(await Promise.all(running)).toEqual(Array(ANONYMOUS_HASHES_AT_ONCE).fill('done'));
    await expect(slots.run(async () => 'again')).resolves.toBe('again');
  });

  it('gives its slot back when a check fails', async () => {
    const slots = new PasswordHashSlots();
    for (let i = 0; i <= ANONYMOUS_HASHES_AT_ONCE; i++) {
      await expect(slots.run(() => Promise.reject(new Error('db')))).rejects.toThrow('db');
    }
    await expect(slots.run(async () => 'free')).resolves.toBe('free');
  });
});
