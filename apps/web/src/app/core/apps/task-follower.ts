import { APP_LIMITS, type AppTask } from '@ilex/shared';
import { catchError, exhaustMap, filter, map, Observable, of, takeWhile, timer } from 'rxjs';
import type { AppsApi } from './apps-api';
import { TASK_POLL_GIVE_UP } from './task-follower.constants';

/**
 * A task as it goes: asked once a second (it runs as a unit on the machine — nothing pushes it),
 * each answer the end of its output; ends with the task — or after `TASK_POLL_GIVE_UP` polls in a
 * row without one (the Linux session closed, the task's record gone), not asking for ever.
 */
export function followTask(appsApi: AppsApi, name: string, folder: string): Observable<AppTask> {
  let missed = 0;
  return timer(0, APP_LIMITS.taskPollMs).pipe(
    exhaustMap(() =>
      appsApi.task(name, folder).pipe(
        map(({ task }) => task),
        catchError(() => of(null)),
      ),
    ),
    takeWhile((task) => {
      missed = task ? 0 : missed + 1;
      return missed < TASK_POLL_GIVE_UP;
    }),
    filter((task): task is AppTask => task !== null),
    takeWhile((task) => task.state === 'running', true),
  );
}
