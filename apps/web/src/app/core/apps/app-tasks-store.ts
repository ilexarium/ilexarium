import { effect, inject } from '@angular/core';
import { signalStore, withHooks, withMethods } from '@ngrx/signals';
import type { AppDeleteRequest, AppInstallRequest, AppStarted } from '@ilex/shared';
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
import { buildAppBackupItem } from '../backups/app-backup-item';
import { BackupsApi } from '../backups/backups-api';
import type { BackupPreset } from '../backups/backups.model';
import { BackupsStore } from '../backups/backups-store';
import { Translator } from '../i18n/translator';
import { LinuxSessionStore } from '../linux/linux-session-store';
import { apiErrorText } from '../../shared/forms/submission-errors';
import { AppsApi } from './apps-api';
import type { AppFollowed } from './apps.model';
import { followTask } from './task-follower';

/**
 * App tasks. The two with a second step after the task — removing an app (then deleting what was
 * ticked) and installing one (then adding it to the backups) — are done here whole, from the start
 * request on: global, so leaving the page drops nothing. Pages only show the progress they return.
 * Dropped at sign-out (nobody to act as).
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

      const failed = (key: string, name: string, error: unknown) =>
        toast.error(translator.t(key, { name }), {
          description: translator.t(...apiErrorText(error)),
        });

      /** As the person; true once done, false when it failed (worded under `key`) or was dismissed. */
      const asPerson = async (key: string, name: string, action: () => Promise<unknown>) => {
        try {
          return (await linuxSessionStore.asPerson(() => action().then(() => true))) === true;
        } catch (error) {
          failed(key, name, error);
          return false;
        }
      };

      const follow = (started: AppStarted): Observable<AppFollowed> =>
        followTask(appsApi, started.name, started.folder).pipe(
          takeUntil(stop$),
          map((task) => ({ task, after: null })),
        );

      /**
       * The task followed here to its end, `then` run once it succeeded — subscribed by this store,
       * so it runs whether a page shows it or not. The page gets the same stream to show.
       */
      const followThen = (started: AppStarted, then: () => Promise<boolean>) => {
        const followed$ = follow(started).pipe(
          concatMap(({ task }) =>
            task.state !== 'succeeded'
              ? of<AppFollowed>({ task, after: null })
              : concat(
                  of<AppFollowed>({ task, after: 'pending' }),
                  from(then()).pipe(
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
      };

      return {
        /** A task without a second step, followed for a page to show. */
        follow,

        /**
         * `docker compose down` as the person, then what was ticked deleted. The progress to show;
         * null when it didn't start (worded in a toast) or the sign-in was dismissed.
         */
        async remove(
          name: string,
          folder: string,
          ticked: AppDeleteRequest | null,
        ): Promise<Observable<AppFollowed> | null> {
          let started: AppStarted | null;
          try {
            started = await linuxSessionStore.asPerson(() =>
              firstValueFrom(appsApi.remove(name, folder)),
            );
          } catch (error) {
            failed('apps.remove.failed', name, error);
            return null;
          }
          if (!started) return null;
          return followThen(started, async () => {
            if (
              ticked &&
              !(await asPerson('apps.remove.deleteFailed', name, () =>
                firstValueFrom(appsApi.delete(name, ticked)),
              ))
            )
              return false;
            toast.success(translator.t('apps.remove.done', { name }));
            return true;
          });
        },

        /**
         * Installs as the person, then adds the app to the backups as chosen (`backup`, null: not).
         * Its start and the progress to show; null when the sign-in was dismissed. Throws when the
         * install was refused, for the page to show why (Compose's answer).
         */
        async install(
          request: AppInstallRequest,
          backup: BackupPreset | null,
        ): Promise<{ started: AppStarted; followed$: Observable<AppFollowed> } | null> {
          const started = await linuxSessionStore.asPerson(() =>
            firstValueFrom(appsApi.install(request)),
          );
          if (!started) return null;
          const { name } = started;
          const followed$ = followThen(started, async () => {
            if (backup && backupsStore.configured())
              await asPerson('apps.new.backupFailed', name, () =>
                firstValueFrom(
                  backupsApi.addItem(buildAppBackupItem(name, started.folder, backup)),
                ),
              );
            toast.success(translator.t('apps.new.installed', { name }));
            return true;
          });
          return { started, followed$ };
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
