import { effect, inject } from '@angular/core';
import { signalStore, withHooks, withMethods } from '@ngrx/signals';
import type { AppStarted } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  concat,
  concatMap,
  finalize,
  firstValueFrom,
  from,
  map,
  type Observable,
  of,
  share,
  Subject,
  Subscription,
  takeUntil,
} from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { BackupsApi } from '../backups/backups-api';
import { BackupsStore } from '../backups/backups-store';
import { Translator } from '../i18n/translator';
import { LinuxSessionStore } from '../linux/linux-session-store';
import { apiErrorText } from '../../shared/forms/submission-errors';
import { AppsApi } from './apps-api';
import type { AppFollowed, AppFollowUp } from './apps.model';
import { followTask } from './task-follower';

/**
 * Follows app tasks whose second half must not depend on the page staying open: the deletion of
 * what was ticked after a removal, adding a new app to the backups after its install. Global, so
 * leaving the page doesn't drop it; dropped at sign-out (nobody to act as).
 */
export const AppTasksStore = signalStore(
  { providedIn: 'root' },
  withMethods(
    (
      _store,
      appsApi = inject(AppsApi),
      backupsApi = inject(BackupsApi),
      backupsStore = inject(BackupsStore),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => {
      const following = new Set<Subscription>();
      // Ends every followed task, also for a page still showing one (sign-out: nobody to act as).
      const stop$ = new Subject<void>();

      /** As the person; true once done, false when it failed (worded under `key`) or was dismissed. */
      const asPerson = async (key: string, name: string, action: () => Promise<unknown>) => {
        try {
          return (await linuxSessionStore.asPerson(() => action().then(() => true))) === true;
        } catch (error) {
          toast.error(translator.t(key, { name }), {
            description: translator.t(...apiErrorText(error)),
          });
          return false;
        }
      };

      const followUp = async (name: string, then: AppFollowUp): Promise<boolean> => {
        switch (then.kind) {
          case 'remove': {
            const request = then.delete;
            if (
              request &&
              !(await asPerson('apps.remove.deleteFailed', name, () =>
                firstValueFrom(appsApi.delete(name, request)),
              ))
            )
              return false;
            toast.success(translator.t('apps.remove.done', { name }));
            return true;
          }
          case 'install': {
            const item = then.backup;
            if (item && backupsStore.configured())
              await asPerson('apps.new.backupFailed', name, () =>
                firstValueFrom(backupsApi.addItem(item)),
              );
            toast.success(translator.t('apps.new.installed', { name }));
            return true;
          }
        }
      };

      return {
        /**
         * The task as it goes, for the page to show. With a follow-up this store follows it too,
         * so it runs once the task succeeds whether the page is still there or not.
         */
        follow(started: AppStarted, then?: AppFollowUp): Observable<AppFollowed> {
          const task$ = followTask(appsApi, started.name, started.folder).pipe(takeUntil(stop$));
          if (!then) return task$.pipe(map((task) => ({ task, after: null })));
          const followed$ = task$.pipe(
            concatMap((task) =>
              task.state !== 'succeeded'
                ? of<AppFollowed>({ task, after: null })
                : concat(
                    of<AppFollowed>({ task, after: 'pending' }),
                    from(followUp(started.name, then)).pipe(
                      catchError(() => of(false)),
                      map((ok): AppFollowed => ({ task, after: ok ? 'done' : 'failed' })),
                    ),
                  ),
            ),
            share(),
          );
          const subscription = new Subscription();
          following.add(subscription);
          subscription.add(
            followed$.pipe(finalize(() => following.delete(subscription))).subscribe(),
          );
          return followed$;
        },

        stopAll(): void {
          stop$.next();
          for (const subscription of following) subscription.unsubscribe();
          following.clear();
        },
      };
    },
  ),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) store.stopAll();
      });
    },
  })),
);
