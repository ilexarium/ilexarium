import { effect, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import type {
  AppDeleteRequest,
  AppInstallRequest,
  AppSaveRequest,
  AppStarted,
  AppTask,
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { firstValueFrom, Subscription } from 'rxjs';
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
import { followTask } from './task-follower';

interface AppTasksState {
  /** Each app's latest task by its name, kept until that app's next one. */
  tasks: Record<string, AppTaskEntry>;
  /** The last entry's id: an entry with a higher one started later. */
  lastId: number;
}

const initialState: AppTasksState = { tasks: {}, lastId: 0 };

/**
 * What happens when a task ends: `onSucceeded` (its second step; true: done), `onFailed` once it
 * ended any other way (failed, interrupted).
 */
interface TaskEnd {
  /** Given the sign-in count it started under, for its requests (see `asPerson`). */
  onSucceeded?: (at: number) => Promise<boolean>;
  onFailed?: () => void;
}

/** Whether a task and its second step are through. */
export const taskEnded = (entry: AppTaskEntry): boolean =>
  entry.task.state !== 'running' && entry.after !== 'pending';

/**
 * Every app task — save, update, start, remove, install — started, followed to its end and
 * finished here, its state in `tasks` for pages to read: global, so leaving a page drops nothing.
 * Removing then deletes what was ticked, installing adds the app to the backups. Emptied at
 * sign-out (nobody to act as).
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
      /** One poll per app. */
      const polls = new Map<string, Subscription>();
      // Counts sign-outs: a task whose start answered after one is never followed (or it would
      // finish as whoever signed in next).
      let signOuts = 0;

      const patchEntry = (name: string, id: number, change: Partial<AppTaskEntry>) => {
        const entry = store.tasks()[name];
        // A newer task of the app replaced it meanwhile.
        if (entry?.id !== id) return;
        patchState(store, { tasks: { ...store.tasks(), [name]: { ...entry, ...change } } });
      };

      /**
       * A second step's request as the person: true once done, false when it failed (worded under
       * `key`), was dismissed, or a sign-out came first — checked again after the sign-in prompt,
       * right before the request, so it never goes out as whoever signed in next.
       */
      const asPerson = async (
        key: string,
        name: string,
        at: number,
        action: () => Promise<unknown>,
      ) => {
        try {
          const done = await linuxSessionStore.asPerson(() =>
            signOuts === at ? action().then(() => true) : Promise.resolve(false),
          );
          return done === true;
        } catch (error) {
          toast.error(translator.t(key, { name }), {
            description: translator.t(...apiErrorText(error)),
          });
          return false;
        }
      };

      /**
       * Follows a task to its end in `tasks`: `onSucceeded` run once it succeeded (its `after`),
       * `onFailed` once it ended otherwise; neither after a sign-out. Replaces the app's earlier
       * entry and stops its poll. A poll that gives up drops the entry: the page reads the task
       * with the app's files instead.
       */
      const track = (
        kind: AppTaskKind,
        name: string,
        folder: string,
        task: AppTask,
        { onSucceeded, onFailed }: TaskEnd = {},
      ) => {
        polls.get(name)?.unsubscribe();
        const at = signOuts;
        const id = store.lastId() + 1;
        patchState(store, {
          lastId: id,
          tasks: { ...store.tasks(), [name]: { id, kind, folder, task, after: null } },
        });
        const poll = new Subscription();
        polls.set(name, poll);
        poll.add(
          followTask(appsApi, name, folder).subscribe({
            next: (latest) => {
              const ended = latest.state !== 'running';
              const succeeded = latest.state === 'succeeded';
              const stepNow = succeeded && !!onSucceeded && signOuts === at;
              patchEntry(name, id, { task: latest, ...(stepNow && { after: 'pending' }) });
              if (ended && !succeeded && signOuts === at) onFailed?.();
              if (!stepNow) return;
              void onSucceeded(at)
                .catch(() => false)
                .then((ok) => patchEntry(name, id, { after: ok ? 'done' : 'failed' }));
            },
            complete: () => {
              if (polls.get(name) === poll) polls.delete(name);
              const entry = store.tasks()[name];
              if (entry?.id === id && entry.task.state === 'running') {
                const { [name]: _gaveUp, ...rest } = store.tasks();
                patchState(store, { tasks: rest });
              }
            },
          }),
        );
      };

      /**
       * Starts a task as the person and follows it. Its start; null when the sign-in was dismissed
       * or a sign-out came first. Throws when the start was refused, for the page to word.
       */
      const begin = async (
        kind: AppTaskKind,
        start: () => Promise<AppStarted>,
        end: (started: AppStarted) => TaskEnd = () => ({}),
      ): Promise<AppStarted | null> => {
        const before = signOuts;
        const started = await linuxSessionStore.asPerson(start);
        if (!started || signOuts !== before) return null;
        track(kind, started.name, started.folder, started.task, end(started));
        return started;
      };

      return {
        /** Saves an app's files and applies them; a refused save throws (e.g. changed on disk). */
        save(name: string, request: AppSaveRequest): Promise<AppStarted | null> {
          return begin('save', () => firstValueFrom(appsApi.save(name, request)));
        },

        update(name: string, folder: string): Promise<AppStarted | null> {
          return begin('update', () => firstValueFrom(appsApi.update(name, folder)));
        },

        /**
         * `up` for an app without containers. `announce`: say so in toasts — that it's starting,
         * and how it ended (a card has no task output to show).
         */
        async start(name: string, folder: string, announce = false): Promise<AppStarted | null> {
          const started = await begin(
            'start',
            () => firstValueFrom(appsApi.start(name, folder)),
            () =>
              announce
                ? {
                    onSucceeded: async () => {
                      toast.success(translator.t('apps.starting.done', { name }));
                      return true;
                    },
                    onFailed: () => toast.error(translator.t('apps.starting.failed', { name })),
                  }
                : {},
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
          return begin(
            'remove',
            () => firstValueFrom(appsApi.remove(name, folder)),
            () => ({
              onSucceeded: async (at) => {
                if (
                  ticked &&
                  !(await asPerson('apps.remove.deleteFailed', name, at, () =>
                    firstValueFrom(appsApi.delete(name, ticked)),
                  ))
                )
                  return false;
                toast.success(translator.t('apps.remove.done', { name }));
                return true;
              },
            }),
          );
        },

        /**
         * Installs as the person, then adds the app to the backups as chosen (`backup`, null: not).
         * A refused install throws Compose's answer.
         */
        install(
          request: AppInstallRequest,
          backup: BackupPreset | null,
        ): Promise<AppStarted | null> {
          return begin(
            'install',
            () => firstValueFrom(appsApi.install(request)),
            ({ name, folder }) => ({
              onSucceeded: async (at) => {
                if (backup && backupsStore.configured())
                  await asPerson('apps.new.backupFailed', name, at, () =>
                    firstValueFrom(backupsApi.addItem(buildAppBackupItem(name, folder, backup))),
                  );
                toast.success(translator.t('apps.new.installed', { name }));
                return true;
              },
            }),
          );
        },

        /** A task found running (an app page opened during it): followed too, unless it is already. */
        watch(name: string, folder: string, task: AppTask): void {
          // An answer read around a sign-out starts nothing for whoever signs in next.
          if (task.state !== 'running' || polls.has(name) || !authStore.isAuthenticated()) return;
          track('watched', name, folder, task);
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
          signOuts++;
          for (const poll of polls.values()) poll.unsubscribe();
          polls.clear();
          // The ids go on counting: a page's "started after I opened" never mistakes an old one.
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
