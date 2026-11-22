import { APP_LIMITS, type AppTask } from '@ilex/shared';
import {
  catchError,
  defer,
  exhaustMap,
  filter,
  map,
  type Observable,
  of,
  takeWhile,
  timer,
} from 'rxjs';
import type { AppsApi } from './apps-api';
import { TASK_POLL_GIVE_UP } from './follow-app-task.constants';

/**
 * An app's task, asked for once a second until it isn't running (that answer is the last), for a
 * page to show. Display only: nothing waits on it to start something else. Gives up after
 * `TASK_POLL_GIVE_UP` polls in a row without an answer; a failed request is one of them.
 */
export function followAppTask(appsApi: AppsApi, name: string, folder: string): Observable<AppTask> {
  return defer(() => {
    let missed = 0;
    return timer(0, APP_LIMITS.taskPollMs).pipe(
      exhaustMap(() =>
        appsApi.task(name, folder).pipe(
          map((answer) => answer.task),
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
  });
}
