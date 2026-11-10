import { APP_LIMITS, type AppTask } from '@ilex/shared';
import { catchError, EMPTY, exhaustMap, Observable, takeWhile, timer } from 'rxjs';
import type { AppsApi } from '../../core/apps/apps-api';

/**
 * A task as it goes: asked once a second (it runs as a unit on the machine — nothing pushes it),
 * each answer the end of its output; ends with the task.
 */
export function followTask(appsApi: AppsApi, name: string, folder: string): Observable<AppTask> {
  return timer(0, APP_LIMITS.taskPollMs).pipe(
    exhaustMap(() => appsApi.task(name, folder).pipe(catchError(() => EMPTY))),
    exhaustMap(({ task }) => (task ? [task] : EMPTY)),
    takeWhile((task) => task.state === 'running', true),
  );
}
