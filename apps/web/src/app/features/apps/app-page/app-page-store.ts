import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  APP_ERROR_CODES,
  type AppDetails,
  type AppRemovalItem,
  type AppStarted,
  type AppTask,
  type BackupItemRequest,
  parseEnv,
  setEnvValues,
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, firstValueFrom, type Observable, pipe, switchMap, tap } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppsStore } from '../../../core/apps/apps-store';
import { followAppTask } from '../../../core/apps/follow-app-task';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { apiErrorCode, apiErrorText } from '../../../shared/forms/submission-errors';
import { appStats } from '../app-stats';
import type { AppTab, ContainerWithStats } from '../apps.model';

interface AppPageState {
  name: string;
  folderHint: string | null;
  details: AppDetails | null;
  /** Why it couldn't be read (an error code), or null. */
  loadError: string | null;
  /** Being edited (the files as read, until saved). */
  compose: string;
  env: string;
  /** Saved with other files on disk meanwhile: reload, or overwrite. */
  conflict: boolean;
  /** A request of this page's in flight. */
  requesting: boolean;
  /** The task this page follows, as last read. */
  followed: AppTask | null;
  /** The backup run "Back up now" started, until the backups topic shows it ended. */
  startedRun: string | null;
  /** What "Delete files" may delete; null while it loads. */
  removal: AppRemovalItem[] | null;
  /** Its settings deleted: back to the list. */
  removed: boolean;
  /** The open tab (the page keeps it in the URL). */
  tab: AppTab;
}

const initialState: AppPageState = {
  name: '',
  folderHint: null,
  details: null,
  loadError: null,
  compose: '',
  env: '',
  conflict: false,
  requesting: false,
  followed: null,
  startedRun: null,
  removal: null,
  removed: false,
  tab: 'overview',
};

/**
 * One app's page: its files read as the signed-in Linux account (fresh each time), the form and
 * the editor, Update, the backup, Remove and Delete files. Every action is one request; the page
 * follows the task it started (or found running) only to show it, and reads the files again at
 * its end.
 */
export const AppPageStore = signalStore(
  withState<AppPageState>(initialState),
  withComputed(
    (
      store,
      appsStore = inject(AppsStore),
      backupsStore = inject(BackupsStore),
      containerActionsStore = inject(ContainerActionsStore),
      monitoringStore = inject(MonitoringStore),
    ) => {
      /** The app's latest task: the one followed here, or the one read with its files if newer. */
      const task = computed(() => {
        const followed = store.followed();
        const read = store.details()?.task ?? null;
        if (!followed || !read) return followed ?? read;
        return followed.startedAt >= read.startedAt ? followed : read;
      });
      const running = computed(() => task()?.state === 'running');
      /** Live from the containers topic, else as read with the files. */
      const summary = computed(
        () =>
          appsStore.apps()?.find((app) => app.name === store.name()) ??
          store.details()?.app ??
          null,
      );
      /** Its containers, live (from Docker: no Linux sign-in needed). */
      const containers = computed(() => {
        const snapshot = monitoringStore.containers();
        return (snapshot?.dockerAvailable ? snapshot.containers : [])
          .filter((c) => c.composeProject === store.name() && !c.protected)
          .sort((a, b) => a.name.localeCompare(b.name));
      });
      const history = computed(() => {
        const snapshot = monitoringStore.containers();
        return snapshot?.dockerAvailable ? snapshot.history : {};
      });
      const backup = computed(() => backupsStore.apps().get(store.name()) ?? null);
      /** Started here and not yet ended (the topic may not show it yet). */
      const startedRunPending = computed(() => {
        const runId = store.startedRun();
        return !!runId && backupsStore.status()?.lastRun?.id !== runId;
      });
      return {
        summary,
        containers,
        history,
        stats: computed(() => appStats(containers(), history())),
        containerStats: computed<ContainerWithStats[]>(() =>
          containers().map((container) => ({
            container,
            stats: appStats([container], history()),
          })),
        ),
        /** Its template as the catalog has it; null without one, or one no longer there. */
        template: computed(() => {
          const id = summary()?.template?.id;
          return id ? (appsStore.templatesById().get(id) ?? null) : null;
        }),
        values: computed(() => parseEnv(store.env())),
        changed: computed(() => {
          const details = store.details();
          return !!details && (details.compose !== store.compose() || details.env !== store.env());
        }),
        backup,
        backupsConfigured: backupsStore.configured,
        /** A backup runs (only one at a time): no "Back up now" meanwhile. */
        backupRunning: computed(() => backupsStore.running() !== null || startedRunPending()),
        /** This app's backup runs or waits in the running one (it may stop the app): no update. */
        appBackingUp: computed(() => {
          const item = backup();
          const run = backupsStore.running();
          if (startedRunPending() && (!run || run.runId === store.startedRun())) return true;
          return (
            !!item &&
            !!run &&
            run.items.some((entry) => entry.itemId === item.id && entry.state !== 'done')
          );
        }),
        task,
        running,
        busy: store.requesting,
        /** Its files read and no container of it in Docker, running or stopped: they may go. */
        filesOnly: computed(
          () => !!store.details() && summary()?.state === 'none' && containers().length === 0,
        ),
        pending: computed(() => {
          const pending = containerActionsStore.pending();
          return (summary()?.containers ?? []).some((name) => pending.has(name));
        }),
        // A link's folder only for an app neither Docker nor the list knows (one just installed
        // elsewhere): never in place of the folder Docker runs it from.
        folder: computed(
          () => store.details()?.folder ?? summary()?.folder ?? store.folderHint() ?? '',
        ),
      };
    },
  ),
  withMethods(
    (
      store,
      appsApi = inject(AppsApi),
      appsStore = inject(AppsStore),
      backupsApi = inject(BackupsApi),
      linuxSessionStore = inject(LinuxSessionStore),
      containerActionsStore = inject(ContainerActionsStore),
      translator = inject(Translator),
    ) => {
      const failed = (errorKey: string, error: unknown) =>
        toast.error(translator.t(errorKey, { name: store.name() }), {
          description: translator.t(...apiErrorText(error)),
        });

      const load = rxMethod<void>(
        pipe(
          switchMap(() =>
            appsApi.details(store.name(), store.folderHint() ?? undefined).pipe(
              tap((details) => {
                patchState(store, {
                  details,
                  // Kept: once Docker no longer knows the app (removed), its folder is still found.
                  folderHint: details.folder,
                  loadError: null,
                  compose: details.compose,
                  env: details.env,
                  conflict: false,
                });
                // Opened during a task (started elsewhere, or before a reload): followed too.
                if (details.task?.state === 'running')
                  follow({ folder: details.folder, task: details.task });
              }),
              catchError((error: unknown) => {
                patchState(store, { loadError: apiErrorCode(error) ?? 'failed' });
                return EMPTY;
              }),
            ),
          ),
        ),
      );

      /**
       * The app's task, until it ends (a newer one replaces it; null: none), then the files read
       * again. Only to show it: nothing else waits for it.
       */
      const follow = rxMethod<Pick<AppStarted, 'folder' | 'task'> | null>(
        pipe(
          switchMap((started) => {
            if (!started) return EMPTY;
            patchState(store, { followed: started.task });
            if (started.task.state !== 'running') return EMPTY;
            return followAppTask(appsApi, store.name(), started.folder).pipe(
              tap({
                next: (task) => patchState(store, { followed: task }),
                // Ended or given up (never when the page is left or a newer task replaces it).
                complete: () => {
                  // Given up while it ran: what the files say instead.
                  if (store.followed()?.state === 'running') patchState(store, { followed: null });
                  load();
                },
              }),
            );
          }),
        ),
      );

      /** As the person; `requesting` meanwhile; the error worded under `errorKey`. */
      const asPerson = async <T>(
        errorKey: string,
        action: () => Promise<T>,
        handleRefusal?: (error: unknown) => boolean,
      ): Promise<T | null> => {
        patchState(store, { requesting: true });
        try {
          return await linuxSessionStore.asPerson(action);
        } catch (error) {
          if (!handleRefusal?.(error)) failed(errorKey, error);
          return null;
        } finally {
          patchState(store, { requesting: false });
        }
      };

      /** Starts a task as the person and follows it. */
      const startTask = async (
        errorKey: string,
        start: () => Observable<AppStarted>,
        handleRefusal?: (error: unknown) => boolean,
      ): Promise<void> => {
        const name = store.name();
        const started = await asPerson(errorKey, () => firstValueFrom(start()), handleRefusal);
        // Answered after another app was opened here: not this page's.
        if (started && started.name === name && store.name() === name) follow(started);
      };

      return {
        open(name: string, folder: string | null): void {
          follow(null);
          patchState(store, { ...initialState, name, folderHint: folder, tab: store.tab() });
          load();
        },

        setTab(tab: AppTab): void {
          patchState(store, { tab });
        },

        reload(): void {
          load();
        },

        /** Signed in to Linux first, then read (the files are the person's). */
        async signInAndLoad(): Promise<void> {
          await linuxSessionStore.asPerson(async () => load());
        },

        setValue(key: string, value: string): void {
          patchState(store, { env: setEnvValues(store.env(), { [key]: value }) });
        },

        setCompose(compose: string): void {
          patchState(store, { compose });
        },

        setEnv(env: string): void {
          patchState(store, { env });
        },

        /** Saves both files and applies them; `overwrite` after "changed on disk". */
        async save(overwrite = false): Promise<void> {
          const details = store.details();
          if (!details) return;
          patchState(store, { conflict: false });
          await startTask(
            'apps.save.failed',
            () =>
              appsApi.save(store.name(), {
                folder: details.folder,
                compose: store.compose(),
                env: store.env(),
                hash: details.hash,
                overwrite,
              }),
            (error) => {
              if (apiErrorCode(error) !== APP_ERROR_CODES.changedOnDisk) return false;
              patchState(store, { conflict: true });
              return true;
            },
          );
        },

        async update(): Promise<void> {
          await startTask('apps.update.failed', () => appsApi.update(store.name(), store.folder()));
        },

        /** Starts this app's backup; its progress comes with the `backups` topic. */
        async backUpNow(): Promise<void> {
          const item = store.backup();
          if (!item) return;
          const run = await asPerson('apps.backup.runFailed', () =>
            firstValueFrom(backupsApi.runNow(item.id)),
          );
          if (!run) return;
          patchState(store, { startedRun: run.runId });
          toast.info(translator.t('apps.backup.started', { name: store.name() }));
        },

        async addToBackups(): Promise<void> {
          let request: BackupItemRequest;
          try {
            request = await appsStore.appBackupItem({
              name: store.name(),
              folder: store.folder() || null,
              template: store.details()?.template ?? store.summary()?.template ?? null,
            });
          } catch (error) {
            failed('apps.backup.failed', error);
            return;
          }
          const item = await asPerson('apps.backup.failed', () =>
            firstValueFrom(backupsApi.addItem(request)),
          );
          if (item) toast.success(translator.t('apps.backup.added', { name: store.name() }));
        },

        async act(action: 'start' | 'stop'): Promise<void> {
          const summary = store.summary();
          if (!summary) return;
          if (action === 'start' && summary.state === 'none') {
            await startTask('apps.starting.failed', () =>
              appsApi.start(store.name(), store.folder()),
            );
            return;
          }
          await containerActionsStore.runAll(summary.containers, action, store.name());
        },

        /** `docker compose down`: its containers go, its files stay. */
        async remove(): Promise<void> {
          await startTask('apps.remove.failed', () => appsApi.remove(store.name(), store.folder()));
        },

        /** What "Delete files" may delete, with sizes. */
        async openDeletion(): Promise<void> {
          patchState(store, { removal: null });
          const removal = await asPerson('apps.delete.failed', () =>
            firstValueFrom(appsApi.removal(store.name(), store.folder())),
          );
          if (removal) patchState(store, { removal: removal.items });
        },

        /** Deletes what was ticked; with its settings the app is gone (back to the list). */
        async deleteFiles(ticked: AppRemovalItem[]): Promise<void> {
          if (ticked.length === 0) return;
          const settings = ticked.some((i) => i.kind === 'settings');
          const done = await asPerson('apps.delete.failed', async () => {
            await firstValueFrom(
              appsApi.delete(store.name(), {
                folder: store.folder(),
                settings,
                folders: ticked.filter((i) => i.kind === 'folder').map((i) => i.path),
                volumes: ticked.filter((i) => i.kind === 'volume').map((i) => i.path),
              }),
            );
            return true;
          });
          if (!done) {
            load();
            return;
          }
          toast.success(translator.t('apps.delete.done', { name: store.name() }));
          if (settings) patchState(store, { removed: true });
          else load();
        },
      };
    },
  ),
  withHooks((_store, monitoringStore = inject(MonitoringStore)) => {
    let stop: (() => void) | undefined;
    return {
      onInit() {
        stop = monitoringStore.watch(['containers']);
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
