import { firstValueFrom, toArray } from 'rxjs';
import { safely } from './safely.js';

describe('safely', () => {
  it('passes the value on', async () => {
    expect(
      await firstValueFrom(
        safely(
          () => Promise.resolve(3),
          () => undefined,
        ),
      ),
    ).toBe(3);
  });

  it('hands a failure to onError and completes without a value', async () => {
    const onError = vi.fn();
    const values = await firstValueFrom(
      safely(() => Promise.reject(new Error('no')), onError).pipe(toArray()),
    );
    expect(values).toEqual([]);
    expect(onError).toHaveBeenCalledWith(new Error('no'));
  });

  it('starts the work only when subscribed', async () => {
    const work = vi.fn(async () => 1);
    const step = safely(work, () => undefined);
    expect(work).not.toHaveBeenCalled();
    await firstValueFrom(step);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
