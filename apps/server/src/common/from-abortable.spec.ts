import { fromAbortable } from './from-abortable.js';

async function* counting(signal: AbortSignal, seen: { signal?: AbortSignal }) {
  seen.signal = signal;
  yield 1;
  yield 2;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  throw new Error('aborted');
}

describe('fromAbortable', () => {
  it('passes the values on and aborts when unsubscribed, without reporting the abort', async () => {
    const seen: { signal?: AbortSignal } = {};
    const values: number[] = [];
    const error = vi.fn();
    const subscription = fromAbortable((signal) => counting(signal, seen)).subscribe({
      next: (value) => values.push(value),
      error,
    });
    await vi.waitFor(() => expect(values).toEqual([1, 2]));
    subscription.unsubscribe();
    expect(seen.signal!.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).not.toHaveBeenCalled();
  });

  it('completes when the iterable ends, and reports its errors', async () => {
    const complete = vi.fn();
    fromAbortable(async function* () {
      yield 1;
    }).subscribe({ complete });
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());

    const error = vi.fn();
    fromAbortable<number>(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('gone')) }),
    })).subscribe({ error });
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(new Error('gone')));
  });
});
