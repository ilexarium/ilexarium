import type { AppTask } from '@ilex/shared';
import { APP_LIMITS } from '@ilex/shared';
import { type Observable, of, throwError } from 'rxjs';
import type { AppsApi } from './apps-api';
import { followAppTask } from './follow-app-task';
import { TASK_POLL_GIVE_UP } from './follow-app-task.constants';
import { testTask } from './testing';

/** Answers one per poll, the last one repeating; `'error'`: the request fails. */
function fakeApi(answers: (AppTask | null | 'error')[]) {
  const task = vi.fn((): Observable<{ task: AppTask | null }> => {
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    return next === 'error' ? throwError(() => new Error('down')) : of({ task: next ?? null });
  });
  return { api: { task } as unknown as AppsApi, task };
}

function follow(api: AppsApi) {
  const seen: AppTask[] = [];
  let done = false;
  const subscription = followAppTask(api, 'music', '/home/anna/apps/music').subscribe({
    next: (task) => seen.push(task),
    complete: () => (done = true),
  });
  return { seen, done: () => done, subscription };
}

describe('followAppTask', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks once a second, each answer on, and ends with the first that isn’t running', async () => {
    const { api, task } = fakeApi([
      testTask(),
      testTask({ output: ['pulling'] }),
      testTask({ state: 'succeeded' }),
    ]);
    const { seen, done } = follow(api);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * 10);
    expect(seen.map((t) => t.state)).toEqual(['running', 'running', 'succeeded']);
    expect(done()).toBe(true);
    expect(task).toHaveBeenCalledTimes(3);
    expect(task).toHaveBeenCalledWith('music', '/home/anna/apps/music');
  });

  it('a failed request or no task doesn’t end it: the next answer counts', async () => {
    const { api } = fakeApi(['error', null, 'error', testTask({ state: 'failed' })]);
    const { seen, done } = follow(api);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * 10);
    expect(seen.map((t) => t.state)).toEqual(['failed']);
    expect(done()).toBe(true);
  });

  it('gives up after so many polls in a row without an answer', async () => {
    const { api, task } = fakeApi(['error']);
    const { seen, done } = follow(api);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * (TASK_POLL_GIVE_UP + 5));
    expect(task).toHaveBeenCalledTimes(TASK_POLL_GIVE_UP);
    expect(seen).toEqual([]);
    expect(done()).toBe(true);
  });

  it('an answer in between starts the count again', async () => {
    const answers: (AppTask | null)[] = [
      ...Array<null>(TASK_POLL_GIVE_UP - 1).fill(null),
      testTask(),
      null,
    ];
    const { api, task } = fakeApi(answers);
    const { done } = follow(api);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * (TASK_POLL_GIVE_UP + 5));
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * TASK_POLL_GIVE_UP);
    expect(done()).toBe(true);
    expect(task).toHaveBeenCalledTimes(TASK_POLL_GIVE_UP * 2);
  });

  it('unsubscribed: no more polls', async () => {
    const { api, task } = fakeApi([testTask()]);
    const { subscription } = follow(api);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * 2);
    subscription.unsubscribe();
    const calls = task.mock.calls.length;
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * 5);
    expect(task).toHaveBeenCalledTimes(calls);
  });
});
