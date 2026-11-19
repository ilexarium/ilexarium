import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import {
  APP_LIMITS,
  type AppDeleteRequest,
  type AppInstallRequest,
  type AppSaveRequest,
  type AppStarted,
  type AppTask,
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { firstValueFrom } from 'rxjs';
import { AuthStore } from '../auth/auth-store';
import { buildAppBackupItem } from '../backups/app-backup-item';
import { BackupsApi } from '../backups/backups-api';
import type { BackupPreset } from '../backups/backups.model';
import { BackupsStore } from '../backups/backups-store';
import { Translator } from '../i18n/translator';
import { LinuxSessionStore } from '../linux/linux-session-store';
import { apiErrorText } from '../../shared/forms/submission-errors';
import { AppsApi } from './apps-api';
import type { AppTaskEntry, AppTaskKind, AppTasksVisit } from './apps.model';
import { TASK_POLL_GIVE_UP } from './app-tasks-store.constants';

interface AppTasksState {
  /** Each app's latest task by its name, kept until that app's next one. */
  tasks: Record<string, AppTaskEntry>;
  /** The last entry's id: an entry with a higher one started later. */
  lastId: number;
}

const initialState: AppTasksState = { tasks: {}, lastId: 0 };

/** Whether a task and its second step are through. */
export const taskEnded = (entry: AppTaskEntry): boolean =>
  entry.task.state !== 'running' && entry.after !== 'pending';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every app task — save, update, start, remove, install — done here as a plain sequence: start it
 * as the person, wait until it's done (each answer in `tasks`, for pages to read), then the second
 * step if it has one (a removal deletes what was ticked, an install adds the app to the backups).
 * Global, so leaving a page drops nothing. Emptied at sign-out.
 */
export const AppTasksStore = signalStore(
  { providedIn: 'root' },
  withState<AppTasksState>(initialState),
  withMethods(
    (
      store,
      authStore = inject(AuthStore),
      appsApi = inject(AppsApi),
      backupsApi = inject(BackupsApi),
      backupsStore = inject(BackupsStore),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => {
      // Counts sign-outs. Whatever began under an earlier sign-in stops at its next step: it must
      // never go on as whoever signs in next.
      let signIn = 0;

      const addEntry = (kind: AppTaskKind, name: string, folder: string, task: AppTask) => {
        const id = store.lastId() + 1;
        patchState(store, {
          lastId: id,
          tasks: { ...store.tasks(), [name]: { id, kind, folder, task, after: null } },
        });
        return id;
      };

      /** Still the app's latest task, under the same sign-in. */
      const stillCurrent = (name: string, id: number, since: number) =>
        signIn === since && store.tasks()[name]?.id === id;

      const updateEntry = (name: string, id: number, change: Partial<AppTaskEntry>) => {
        const entry = store.tasks()[name];
        if (entry?.id !== id) return;
        patchState(store, { tasks: { ...store.tasks(), [name]: { ...entry, ...change } } });
      };

      const dropEntry = (name: string) => {
        const { [name]: _dropped, ...rest } = store.tasks();
        patchState(store, { tasks: rest });
      };

      /**
       * Asks for the task once a second until it's done, each answer into its entry. Its end; null
       * when it stopped first — a newer task of the app, a sign-out, or no answer for
       * `TASK_POLL_GIVE_UP` polls in a row (the entry dropped: the page reads the task with the
       * files). `thenMore`: a second step follows success — marked pending with the end, so a page
       * never sees it as through in between.
       */
      const waitUntilDone = async (
        name: string,
        folder: string,
        id: number,
        since: number,
        thenMore: boolean,
      ): Promise<AppTask | null> => {
        // The start's own answer is shown first; asked from the next tick on, then once a second.
        for (let missed = 0, wait = 0; ; wait = APP_LIMITS.taskPollMs) {
          await sleep(wait);
          if (!stillCurrent(name, id, since)) return null;
          const answer = await firstValueFrom(appsApi.task(name, folder)).catch(() => null);
          if (!stillCurrent(name, id, since)) return null;
          const task = answer?.task;
          if (!task) {
            if (++missed < TASK_POLL_GIVE_UP) continue;
            dropEntry(name);
            return null;
          }
          missed = 0;
          const done = task.state !== 'running';
          const more = done && thenMore && task.state === 'succeeded';
          updateEntry(name, id, { task, ...(more && { after: 'pending' as const }) });
          if (done) return task;
        }
      };

      /**
       * A second step's request as the person: true once done, false when it failed (worded under
       * `errorKey`) or was dismissed. Checked against the sign-in again after any prompt, right
       * before the request.
       */
      const asPerson = async (
        errorKey: string,
        name: string,
        since: number,
        request: () => Promise<unknown>,
      ): Promise<boolean> => {
        try {
          const done = await linuxSessionStore.asPerson(() =>
            signIn === since ? request().then(() => true) : Promise.resolve(false),
          );
          return done === true;
        } catch (error) {
          toast.error(translator.t(errorKey, { name }), {
            description: translator.t(...apiErrorText(error)),
          });
          return false;
        }
      };

      /**
       * Starts a task as the person and returns once it has started; waiting for its end and
       * `afterwards` (given that end) go on by themselves. Null when the sign-in was dismissed or
       * a sign-out came first; throws when the start was refused, for the page to word.
       */
      const run = async (
        kind: AppTaskKind,
        start: () => Promise<AppStarted>,
        afterwards?: {
          thenMore: boolean;
          step: (task: AppTask, id: number, started: AppStarted) => Promise<void>;
        },
      ): Promise<AppStarted | null> => {
        const since = signIn;
        const started = await linuxSessionStore.asPerson(start);
        if (!started || signIn !== since) return null;
        const { name, folder } = started;
        const id = addEntry(kind, name, folder, started.task);
        void (async () => {
          const task = await waitUntilDone(name, folder, id, since, !!afterwards?.thenMore);
          if (task && afterwards && signIn === since) await afterwards.step(task, id, started);
        })().catch(() => undefined);
        return started;
      };

      /** The second step's outcome into the entry. */
      const finished = (name: string, id: number, ok: boolean) =>
        updateEntry(name, id, { after: ok ? 'done' : 'failed' });

      return {
        /** Saves an app's files and applies them; a refused save throws (e.g. changed on disk). */
        save(name: string, request: AppSaveRequest): Promise<AppStarted | null> {
          return run('save', () => firstValueFrom(appsApi.save(name, request)));
        },

        update(name: string, folder: string): Promise<AppStarted | null> {
          return run('update', () => firstValueFrom(appsApi.update(name, folder)));
        },

        /**
         * `up` for an app without containers. `announce`: say in toasts that it's starting and how
         * it ended (a card has no task output to show).
         */
        async start(name: string, folder: string, announce = false): Promise<AppStarted | null> {
          const started = await run(
            'start',
            () => firstValueFrom(appsApi.start(name, folder)),
            announce
              ? {
                  thenMore: false,
                  step: async (task) => {
                    if (task.state === 'succeeded')
                      toast.success(translator.t('apps.starting.done', { name }));
                    else toast.error(translator.t('apps.starting.failed', { name }));
                  },
                }
              : undefined,
          );
          if (started && announce) toast.info(translator.t('apps.starting.started', { name }));
          return started;
        },

        /** `docker compose down` as the person, then what was ticked deleted (null: nothing). */
        remove(
          name: string,
          folder: string,
          ticked: AppDeleteRequest | null,
        ): Promise<AppStarted | null> {
          const since = signIn;
          return run('remove', () => firstValueFrom(appsApi.remove(name, folder)), {
            thenMore: true,
            step: async (task, id) => {
              if (task.state !== 'succeeded') return;
              const ok =
                !ticked ||
                (await asPerson('apps.remove.deleteFailed', name, since, () =>
                  firstValueFrom(appsApi.delete(name, ticked)),
                ));
              if (ok) toast.success(translator.t('apps.remove.done', { name }));
              finished(name, id, ok);
            },
          });
        },

        /**
         * Installs as the person, then adds the app to the backups as chosen (`backup`, null: not).
         * A refused install throws Compose's answer.
         */
        install(
          request: AppInstallRequest,
          backup: BackupPreset | null,
        ): Promise<AppStarted | null> {
          const since = signIn;
          return run('install', () => firstValueFrom(appsApi.install(request)), {
            thenMore: true,
            step: async (task, id, { name, folder }) => {
              if (task.state !== 'succeeded') return;
              if (backup && backupsStore.configured())
                await asPerson('apps.new.backupFailed', name, since, () =>
                  firstValueFrom(backupsApi.addItem(buildAppBackupItem(name, folder, backup))),
                );
              toast.success(translator.t('apps.new.installed', { name }));
              finished(name, id, true);
            },
          });
        },

        /** A task found running (an app page opened during it): waited for too, unless it is already. */
        watch(name: string, folder: string, task: AppTask): void {
          const entry = store.tasks()[name];
          // An answer read around a sign-out starts nothing for whoever signs in next.
          if (task.state !== 'running' || !authStore.isAuthenticated()) return;
          if (entry && !taskEnded(entry)) return;
          const id = addEntry('watched', name, folder, task);
          void waitUntilDone(name, folder, id, signIn, false).catch(() => undefined);
        },

        /** Where a page's visit starts (see `endedDuring`). */
        visit(): AppTasksVisit {
          return {
            after: store.lastId(),
            running: Object.values(store.tasks())
              .filter((entry) => !taskEnded(entry))
              .map((entry) => entry.id),
          };
        },

        /** Whether a task ended during a page's visit: started after it began, or running then. */
        endedDuring(visit: AppTasksVisit | null, entry: AppTaskEntry | undefined): boolean {
          if (!visit || !entry || !taskEnded(entry)) return false;
          return entry.id > visit.after || visit.running.includes(entry.id);
        },

        reset(): void {
          signIn++;
          // The ids go on counting: a page's visit never mistakes an old one.
          patchState(store, { tasks: {} });
        },
      };
    },
  ),
  withHooks((store, authStore = inject(AuthStore)) => ({
    onInit() {
      effect(() => {
        if (!authStore.isAuthenticated()) store.reset();
      });
    },
  })),
);
