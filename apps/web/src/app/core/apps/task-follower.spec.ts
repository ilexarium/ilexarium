import { APP_LIMITS, type AppTask } from '@ilex/shared';
import { type Observable, of, throwError } from 'rxjs';
import type { AppsApi } from './apps-api';
import { followTask } from './task-follower';
import { TASK_POLL_GIVE_UP } from './task-follower.constants';
import { testTask } from './testing';

type Answer = { task: AppTask | null } | 'refused';

function follow(answers: Answer[]) {
  const task = vi.fn((): Observable<{ task: AppTask | null }> => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    return answer === 'refused' ? throwError(() => new Error('403')) : of(answer);
  });
  const seen: AppTask[] = [];
  let ended = false;
  followTask({ task } as unknown as AppsApi, 'music', '/home/anna/apps/music').subscribe({
    next: (t) => seen.push(t),
    complete: () => (ended = true),
  });
  return { task, seen, ended: () => ended };
}

describe('followTask', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks once a second and ends with the task', async () => {
    const { seen, ended } = follow([
      { task: testTask() },
      { task: testTask({ state: 'succeeded' }) },
    ]);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * 2);
    expect(seen.map((t) => t.state)).toEqual(['running', 'succeeded']);
    expect(ended()).toBe(true);
  });

  it('gives up after polls in a row without an answer — never asking for ever', async () => {
    const { task, ended } = follow(['refused']);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * (TASK_POLL_GIVE_UP + 2));
    expect(ended()).toBe(true);
    expect(task).toHaveBeenCalledTimes(TASK_POLL_GIVE_UP);
  });

  it('an answer in between starts the count again', async () => {
    const answers: Answer[] = [
      ...Array.from({ length: TASK_POLL_GIVE_UP - 1 }, (): Answer => 'refused'),
      { task: testTask() },
      'refused',
    ];
    const { ended } = follow(answers);
    await vi.advanceTimersByTimeAsync(APP_LIMITS.taskPollMs * (TASK_POLL_GIVE_UP + 5));
    expect(ended()).toBe(false);
  });
});
