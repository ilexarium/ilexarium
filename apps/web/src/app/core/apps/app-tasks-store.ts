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
  ReplaySubject,
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
import type { AppFollowed, AppTaskStart } from './apps.model';
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
      // Counts sign-outs: a task whose start answered after one is never followed (or it would
      // finish as whoever signed in next).
      let signOuts = 0;

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

      /**
       * Starts a task as the person and follows it here, `then` run once it succeeded. Its start and
       * the progress to show; null when the sign-in was dismissed or a sign-out came first. Throws
       * when the start was refused, for the page to word.
       */
      const startThen = async (
        start: () => Promise<AppStarted>,
        then: (started: AppStarted) => Promise<boolean>,
      ): Promise<AppTaskStart | null> => {
        const before = signOuts;
        const started = await linuxSessionStore.asPerson(start);
        if (!started || signOuts !== before) return null;
        return { started, followed$: followThen(started, () => then(started)) };
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
          // Replayed, never run again: a page reading it late gets the latest state, and the second
          // step runs once.
          share({ connector: () => new ReplaySubject(1), resetOnComplete: false }),
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
         * `docker compose down` as the person, then what was ticked deleted (null: nothing). See
         * `startThen` for what it returns.
         */
        remove(
          name: string,
          folder: string,
          ticked: AppDeleteRequest | null,
        ): Promise<AppTaskStart | null> {
          return startThen(
            () => firstValueFrom(appsApi.remove(name, folder)),
            async () => {
              if (
                ticked &&
                !(await asPerson('apps.remove.deleteFailed', name, () =>
                  firstValueFrom(appsApi.delete(name, ticked)),
                ))
              )
                return false;
              toast.success(translator.t('apps.remove.done', { name }));
              return true;
            },
          );
        },

        /**
         * Installs as the person, then adds the app to the backups as chosen (`backup`, null: not).
         * See `startThen` for what it returns; a refused install throws Compose's answer.
         */
        install(
          request: AppInstallRequest,
          backup: BackupPreset | null,
        ): Promise<AppTaskStart | null> {
          return startThen(
            () => firstValueFrom(appsApi.install(request)),
            async ({ name, folder }) => {
              if (backup && backupsStore.configured())
                await asPerson('apps.new.backupFailed', name, () =>
                  firstValueFrom(backupsApi.addItem(buildAppBackupItem(name, folder, backup))),
                );
              toast.success(translator.t('apps.new.installed', { name }));
              return true;
            },
          );
        },

        stopAll(): void {
          signOuts++;
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
