import { APP_LIMITS, type AppTask } from '@laris/shared';
import { catchError, EMPTY, exhaustMap, Observable, takeWhile, timer } from 'rxjs';
import type { AppsApi } from '../../core/apps/apps-api';

/**
 * A task's output as it grows: asked once a second (it runs as a unit on the machine — nothing
 * pushes it), each answer the lines since the last; ends with the task. Every line arrives once.
 */
export function followTask(appsApi: AppsApi, name: string, folder: string): Observable<AppTask> {
  let from = 0;
  return timer(0, APP_LIMITS.taskPollMs).pipe(
    exhaustMap(() => appsApi.task(name, folder, from).pipe(catchError(() => EMPTY))),
    exhaustMap(({ task }) => {
      if (!task) return EMPTY;
      from = task.next;
      return [task];
    }),
    takeWhile((task) => task.state === 'running', true),
  );
}
