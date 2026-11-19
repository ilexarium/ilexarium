import { computed, effect, inject, untracked } from '@angular/core';
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
  type BackupItemRequest,
  parseEnv,
  setEnvValues,
} from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, firstValueFrom, pipe, switchMap, tap } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppTasksStore, taskEnded } from '../../../core/apps/app-tasks-store';
import { AppsStore } from '../../../core/apps/apps-store';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { apiErrorCode, apiErrorText } from '../../../shared/forms/submission-errors';
import { appStats } from '../app-stats';
import { BACKUP_WAIT_MS } from '../apps.constants';
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
  /** A request of this page's in flight (the tasks themselves are AppTasksStore's). */
  requesting: boolean;
  /**
   * AppTasksStore's last task id when the page opened, and the app's task then still running:
   * the page reacts only to tasks that end during its visit.
   */
  openedAt: number;
  runningAtOpen: number | null;
  removal: AppRemovalItem[] | null;
  /** Removed: back to the list. */
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
  openedAt: 0,
  runningAtOpen: null,
  removal: null,
  removed: false,
  tab: 'overview',
};

/**
 * One app's page: its files read as the signed-in Linux account (fresh each time), the form and
 * the editor, Update, the backup, the removal. The tasks are AppTasksStore's: the page shows the
 * app's latest and reacts when one ends while it's open.
 */
export const AppPageStore = signalStore(
  withState<AppPageState>(initialState),
  withComputed(
    (
      store,
      appTasksStore = inject(AppTasksStore),
      appsStore = inject(AppsStore),
      backupsStore = inject(BackupsStore),
      containerActionsStore = inject(ContainerActionsStore),
      monitoringStore = inject(MonitoringStore),
    ) => {
      const entry = computed(() => appTasksStore.tasks()[store.name()] ?? null);
      /** The app's latest task: the one followed here, or the one read with its files if newer. */
      const task = computed(() => {
        const followed = entry()?.task ?? null;
        const read = store.details()?.task ?? null;
        if (!followed || !read) return followed ?? read;
        return followed.startedAt >= read.startedAt ? followed : read;
      });
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
        backup: computed(() => backupsStore.apps().get(store.name()) ?? null),
        backupsConfigured: backupsStore.configured,
        task,
        running: computed(() => task()?.state === 'running'),
        /** A request in flight, or a task's second step (a removal's deletion) still running. */
        busy: computed(() => store.requesting() || entry()?.after === 'pending'),
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
      appTasksStore = inject(AppTasksStore),
      appsStore = inject(AppsStore),
      backupsApi = inject(BackupsApi),
      backupsStore = inject(BackupsStore),
      linuxSessionStore = inject(LinuxSessionStore),
      containerActionsStore = inject(ContainerActionsStore),
      translator = inject(Translator),
    ) => {
      const failed = (key: string, error: unknown) =>
        toast.error(translator.t(key, { name: store.name() }), {
          description: translator.t(...apiErrorText(error)),
        });

      const load = rxMethod<void>(
        pipe(
          switchMap(() =>
            appsApi.details(store.name(), store.folderHint() ?? undefined).pipe(
              tap((details) =>
                patchState(store, {
                  details,
                  loadError: null,
                  compose: details.compose,
                  env: details.env,
                  conflict: false,
                }),
              ),
              // Opened during a task (started elsewhere, or before a reload): followed too.
              tap((details) => {
                if (details.task) appTasksStore.watch(store.name(), details.folder, details.task);
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
       * A task through AppTasksStore, `requesting` while it starts; a refused start worded under
       * `key` (or handled by `refused`, true when it was).
       */
      const startTask = async (
        key: string,
        start: () => Promise<AppStarted | null>,
        refused?: (error: unknown) => boolean,
      ): Promise<void> => {
        patchState(store, { requesting: true });
        try {
          await start();
        } catch (error) {
          if (!refused?.(error)) failed(key, error);
        } finally {
          patchState(store, { requesting: false });
        }
      };

      /** As the person; `requesting` meanwhile; the error worded under `key`. */
      const asPerson = async <T>(key: string, action: () => Promise<T>): Promise<T | null> => {
        patchState(store, { requesting: true });
        try {
          return await linuxSessionStore.asPerson(action);
        } catch (error) {
          failed(key, error);
          return null;
        } finally {
          patchState(store, { requesting: false });
        }
      };

      /** "Back up this app first": its own backup, waited for (the update comes after). */
      const backUpFirst = async (): Promise<boolean> => {
        const item = store.backup();
        if (!item) return true;
        const run = await asPerson('apps.update.backupFailed', () =>
          firstValueFrom(backupsApi.runNow(item.id)),
        );
        if (!run) return false;
        toast.info(translator.t('apps.update.backingUp', { name: store.name() }));
        for (const deadline = Date.now() + BACKUP_WAIT_MS; Date.now() < deadline;) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const running = backupsStore.running();
          if (running?.runId === run.runId) continue;
          const last = backupsStore.status()?.lastRun;
          if (last?.id === run.runId) return last.status !== 'failed';
        }
        return false;
      };

      return {
        open(name: string, folder: string | null): void {
          const current = appTasksStore.tasks()[name];
          const running = current && !taskEnded(current) ? current : undefined;
          patchState(store, {
            ...initialState,
            name,
            folderHint: folder,
            tab: store.tab(),
            openedAt: appTasksStore.lastId(),
            runningAtOpen: running?.id ?? null,
          });
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
              appTasksStore.save(store.name(), {
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

        async update(backupFirst: boolean): Promise<void> {
          if (backupFirst && !(await backUpFirst())) {
            toast.error(translator.t('apps.update.notBackedUp', { name: store.name() }));
            return;
          }
          await startTask('apps.update.failed', () =>
            appTasksStore.update(store.name(), store.folder()),
          );
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
              appTasksStore.start(store.name(), store.folder()),
            );
            return;
          }
          await containerActionsStore.runAll(summary.containers, action, store.name());
        },

        async openRemoval(): Promise<void> {
          patchState(store, { removal: null });
          const removal = await asPerson('apps.remove.failed', () =>
            firstValueFrom(appsApi.removal(store.name(), store.folder())),
          );
          if (removal) patchState(store, { removal: removal.items });
        },

        /** `docker compose down`, then what was ticked deleted — all of it AppTasksStore's. */
        async remove(ticked: AppRemovalItem[]): Promise<void> {
          const folder = store.folder();
          const request =
            ticked.length > 0
              ? {
                  folder,
                  settings: ticked.some((i) => i.kind === 'settings'),
                  folders: ticked.filter((i) => i.kind === 'folder').map((i) => i.path),
                  volumes: ticked.filter((i) => i.kind === 'volume').map((i) => i.path),
                }
              : null;
          await startTask('apps.remove.failed', () =>
            appTasksStore.remove(store.name(), folder, request),
          );
        },
      };
    },
  ),
  withHooks(
    (store, appTasksStore = inject(AppTasksStore), monitoringStore = inject(MonitoringStore)) => {
      let stop: (() => void) | undefined;
      return {
        onInit() {
          stop = monitoringStore.watch(['containers']);
          // A task ending during this visit (only once each): a removal done is back to the list,
          // any other the files read again. One that had ended before the page opened: nothing.
          let handled = 0;
          effect(() => {
            const entry = appTasksStore.tasks()[store.name()];
            if (!entry || entry.id === handled || !taskEnded(entry)) return;
            if (entry.id <= store.openedAt() && entry.id !== store.runningAtOpen()) return;
            handled = entry.id;
            untracked(() => {
              if (entry.kind === 'remove' && entry.after === 'done') {
                patchState(store, { removed: true });
              } else {
                store.reload();
              }
            });
          });
        },
        onDestroy() {
          stop?.();
        },
      };
    },
  ),
);
