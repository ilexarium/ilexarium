import { computed, effect, inject, untracked } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import {
  type BackupArchive,
  type BackupDestination,
  type BackupFoldersResponse,
  type BackupItem,
  type BackupPlan,
  type BackupPlanUpdate,
  type BackupRestore,
  type BackupRun,
  type BackupItemRequest,
  type BackupItemUpdate,
  type BackupSetupRequest,
  catalogIconPath,
} from '@ilex/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  concat,
  defer,
  EMPTY,
  exhaustMap,
  firstValueFrom,
  forkJoin,
  from,
  lastValueFrom,
  merge,
  mergeMap,
  type Observable,
  of,
  pipe,
  switchMap,
  tap,
} from 'rxjs';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { Translator } from '../../../core/i18n/translator';
import { AppsStore } from '../../../core/apps/apps-store';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { apiErrorCode, apiErrorText } from '../../../shared/forms/submission-errors';
import { runAdded } from '../backup-runs';
import type {
  BackupsHeadline,
  BackupsTab,
  ItemChange,
  ItemRemoval,
  ItemRow,
  RestoreChoice,
} from '../backups.model';

interface BackupsPageState {
  /** Null while loading (`loaded` false) or before setup. */
  plan: BackupPlan | null;
  loaded: boolean;
  failed: boolean;
  destinations: BackupDestination[] | null;
  runs: BackupRun[] | null;
  /** Output of runs opened in the history, by run id. */
  outputs: Record<string, string[]>;
  restores: BackupRestore[] | null;
  /** The archives of the item a restore dialog is open for. */
  archives: { itemId: string; list: BackupArchive[] | null } | null;
  /** The folder picker's current place. */
  folders: BackupFoldersResponse | null;
  /** The passphrase while it's shown (after setup, or "Show again"); never kept longer. */
  passphrase: string | null;
  /** Shown right after setup (the stronger wording). */
  passphraseFirst: boolean;
  /** Actions waiting for the server, for pending buttons (`run`, `run:<item>`, `remove:<item>`…). */
  pending: string[];
  /** The open tab (the page keeps it in the URL). */
  tab: BackupsTab;
  /** The item whose side sheet is open. */
  sheetItemId: string | null;
}

const initialState: BackupsPageState = {
  plan: null,
  loaded: false,
  failed: false,
  destinations: null,
  runs: null,
  outputs: {},
  restores: null,
  archives: null,
  folders: null,
  passphrase: null,
  passphraseFirst: false,
  pending: [],
  tab: 'items',
  sheetItemId: null,
};

/**
 * The Backups page's data, provided by the page and gone with it: the plan and its items, the
 * apps that aren't in it, the disks, run history, restores, the folder picker, and every action
 * with its toast — changes done as the person, through their sudo. Live parts (the running run, the latest restore, warnings) come from the global
 * `BackupsStore`; when they change, the page reloads what they affect.
 */
export const BackupsPageStore = signalStore(
  withState<BackupsPageState>(initialState),
  withComputed((store, backupsStore = inject(BackupsStore)) => ({
    status: computed(() => backupsStore.status()),
    running: computed(() => backupsStore.running()),
  })),
  withComputed((store, appsStore = inject(AppsStore)) => ({
    /** The apps Docker knows (live). */
    apps: computed(() => appsStore.apps() ?? []),

    /**
     * Each app's template icon, by name. Its own step, equal while the icons stay: Docker's
     * updates come every few seconds, and the cards needn't be built again for them.
     */
    icons: computed(
      () => {
        const templates = appsStore.templatesById();
        const icons = new Map<string, string>();
        for (const app of appsStore.apps() ?? []) {
          const id = app.template?.id;
          if (id && templates.has(id)) icons.set(app.name, catalogIconPath(id));
        }
        return icons;
      },
      {
        equal: (a, b) => a.size === b.size && [...a].every(([name, icon]) => b.get(name) === icon),
      },
    ),
  })),
  withComputed((store) => ({
    /** The plan's items as shown: active ones and removed ones (backups kept). */
    rows: computed((): { active: ItemRow[]; removed: ItemRow[] } => {
      const icons = store.icons();
      const row = (item: BackupItem): ItemRow => ({
        item,
        name: item.project,
        icon: (item.project && icons.get(item.project)) || null,
      });
      const items = store.plan()?.items ?? [];
      return {
        active: items.filter((i) => !i.removed).map(row),
        removed: items.filter((i) => i.removed).map(row),
      };
    }),
  })),
  withComputed((store) => ({
    /** Apps that aren't in the plan yet. */
    addable: computed(() => {
      const inPlan = new Set(store.rows().active.map((r) => r.item.project));
      return store.apps().filter((app) => !inPlan.has(app.name));
    }),

    /** The item whose side sheet is open, as it is now; null once it's gone from the plan. */
    sheetRow: computed(
      () => store.rows().active.find((r) => r.item.id === store.sheetItemId()) ?? null,
    ),

    /** The item being backed up right now. */
    runningItemId: computed(
      () => store.running()?.items.find((i) => i.state === 'running')?.itemId ?? null,
    ),

    /** Null until the status and the plan are known. */
    headline: computed((): BackupsHeadline | null => {
      const status = store.status();
      if (!status || !store.plan()) return null;
      if (status.running) {
        const { items } = status.running;
        return {
          kind: 'running',
          done: items.filter((i) => i.state === 'done').length,
          total: items.length,
        };
      }
      const failed = store
        .rows()
        .active.filter((r) => r.item.lastResult?.status === 'failed').length;
      // A failed item already says the last run failed. Failed items show on their cards, not
      // in the warnings band, so the count can be more than the band lists.
      const warnings = status.warnings.filter((w) => !(w === 'lastRunFailed' && failed > 0));
      const count = failed + warnings.length;
      if (count > 0) return { kind: 'attention', count };
      const fresh = store.rows().active.some((r) => r.item.lastSuccessAt === null);
      return status.lastSuccessAt && !fresh
        ? { kind: 'allGood', at: status.lastSuccessAt }
        : { kind: 'never' };
    }),

    /** What each run added, oldest first, for the history's line. */
    sizeLine: computed(() => [...(store.runs() ?? [])].reverse().map(runAdded)),
  })),
  withMethods(
    (
      store,
      backupsApi = inject(BackupsApi),
      appsStore = inject(AppsStore),
      linuxSessionStore = inject(LinuxSessionStore),
      translator = inject(Translator),
    ) => {
      const pending = (key: string, on: boolean) =>
        patchState(store, {
          pending: on ? [...store.pending(), key] : store.pending().filter((k) => k !== key),
        });
      const failed = (key: string, error: unknown, params: Record<string, unknown> = {}) =>
        toast.error(translator.t(key, params), {
          description: translator.t(...apiErrorText(error)),
        });

      /**
       * Runs an action as the person (their sign-in and sudo asked when needed) with a pending
       * marker; a failure is a toast. Resolves true on success.
       */
      async function act(
        key: string,
        failureKey: string,
        request: () => Observable<unknown>,
        params = {},
      ) {
        pending(key, true);
        try {
          // `true` once answered: an empty answer (204) is null too, like a dismissed sign-in.
          const done = await linuxSessionStore.asPerson(() =>
            firstValueFrom(request()).then(() => true),
          );
          return done === true;
        } catch (error) {
          failed(failureKey, error, params);
          return false;
        } finally {
          pending(key, false);
        }
      }

      const appItem = (name: string): Promise<BackupItemRequest> => {
        const app = store.apps().find((a) => a.name === name);
        return appsStore.appBackupItem(app ?? { name, folder: null, template: null });
      };

      const plan$ = () =>
        backupsApi.plan().pipe(
          tap(({ plan }) => patchState(store, { plan, loaded: true, failed: false })),
          catchError(() => {
            patchState(store, { loaded: true, failed: true });
            return EMPTY;
          }),
        );
      // Deferred: whether there is a plan is known only once it's loaded.
      const history$ = () =>
        defer(() =>
          store.plan() ? forkJoin([backupsApi.runs(), backupsApi.restores()]) : EMPTY,
        ).pipe(
          tap(([{ runs }, { restores }]) => patchState(store, { runs, restores })),
          // The page shows the last known history; the next change tries again.
          catchError(() => EMPTY),
        );

      // Every reload of the plan and its history goes through this one pipeline, so the latest
      // asked for wins (after an action, after a change the topic pushed).
      const reload = rxMethod<void>(pipe(switchMap(() => concat(plan$(), history$()))));
      const loadExtras = rxMethod<void>(
        pipe(
          exhaustMap(() =>
            merge(
              backupsApi.destinations().pipe(
                tap(({ destinations }) => patchState(store, { destinations })),
                catchError(() => {
                  patchState(store, { destinations: [] });
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),
      );

      return {
        load(): void {
          loadExtras();
          reload();
        },

        /** After a change pushed by the topic: the plan and the history again. */
        reload,

        /**
         * Sets backups up, as the person, with these apps (their templates' presets) and folders;
         * rejects with the server's error (the form puts it on its fields).
         */
        async setup(
          settings: Omit<BackupSetupRequest, 'items'>,
          apps: string[],
          folders: string[],
        ): Promise<void> {
          const items: BackupSetupRequest['items'] = [
            ...(await Promise.all(apps.map((name) => appItem(name)))),
            ...folders.map((path) => ({ kind: 'folder' as const, path })),
          ];
          const answer = await linuxSessionStore.asPerson(() =>
            firstValueFrom(backupsApi.setup({ ...settings, items })),
          );
          if (!answer) return;
          patchState(store, { passphrase: answer.passphrase, passphraseFirst: true });
          // The form stays busy until the plan shows.
          await lastValueFrom(plan$(), { defaultValue: undefined });
          toast.success(translator.t('backups.setup.done'));
        },

        /** The passphrase was saved by the user: it goes from the page. */
        hidePassphrase(): void {
          patchState(store, { passphrase: null, passphraseFirst: false });
        },

        /** "Show again": through the person's sudo. */
        async showPassphrase(): Promise<void> {
          try {
            const answer = await linuxSessionStore.asPerson(() =>
              firstValueFrom(backupsApi.passphrase()),
            );
            if (answer)
              patchState(store, { passphrase: answer.passphrase, passphraseFirst: false });
          } catch (error) {
            failed('backups.passphrase.failed', error);
          }
        },

        /** Saves schedule, retention or disk, as the person; rejects with the server's error. */
        async updatePlan(update: BackupPlanUpdate): Promise<void> {
          const plan = await linuxSessionStore.asPerson(() =>
            firstValueFrom(backupsApi.updatePlan(update)),
          );
          if (!plan) return;
          patchState(store, { plan });
          toast.success(translator.t('backups.settings.saved'));
        },

        async runNow(itemId?: string): Promise<void> {
          const key = itemId ? `run:${itemId}` : 'run';
          if (await act(key, 'backups.run.failed', () => backupsApi.runNow(itemId))) {
            toast.success(translator.t('backups.run.started'));
          }
        },

        async addApp(name: string): Promise<void> {
          let item: BackupItemRequest;
          try {
            item = await appItem(name);
          } catch (error) {
            failed('backups.items.addFailed', error);
            return;
          }
          if (await act(`add:${name}`, 'backups.items.addFailed', () => backupsApi.addItem(item))) {
            reload();
          }
        },

        async addFolder(path: string): Promise<void> {
          if (
            await act(`add:${path}`, 'backups.items.addFailed', () =>
              backupsApi.addItem({ kind: 'folder', path }),
            )
          ) {
            patchState(store, { folders: null });
            reload();
          }
        },

        async changeItem({ itemId, change }: ItemChange): Promise<void> {
          if (
            await act(`folders:${itemId}`, 'backups.items.foldersFailed', () =>
              backupsApi.updateItem(itemId, change as BackupItemUpdate),
            )
          ) {
            reload();
          }
        },

        /** Out of the plan (already confirmed); `deleteArchives` deletes its backups too. */
        async removeItem({ itemId, deleteArchives }: ItemRemoval): Promise<void> {
          const failure = deleteArchives
            ? 'backups.items.deleteFailed'
            : 'backups.items.removeFailed';
          if (
            await act(`remove:${itemId}`, failure, () =>
              backupsApi.removeItem(itemId, deleteArchives),
            )
          ) {
            reload();
          }
        },

        /**
         * The archives for the restore dialog, read again from the disk first through the person's
         * sudo (the saved lists are a run behind after a recovery); without it, the saved list.
         * Another item opened meanwhile wins.
         */
        loadArchives: rxMethod<string>(
          pipe(
            tap((itemId) => patchState(store, { archives: { itemId, list: null } })),
            switchMap((itemId) =>
              from(
                linuxSessionStore.asPerson(() => firstValueFrom(backupsApi.refreshArchives())),
              ).pipe(
                catchError((error: unknown) => {
                  // A backup running holds the repository: its saved list is just as new.
                  if (apiErrorCode(error) !== 'busy')
                    failed('backups.restore.refreshFailed', error);
                  return of(null);
                }),
                switchMap(() => backupsApi.archives(itemId)),
                tap(({ archives }) => patchState(store, { archives: { itemId, list: archives } })),
                catchError(() => {
                  patchState(store, { archives: { itemId, list: [] } });
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),

        /** Starts a restore (already confirmed); its progress arrives through the topic. */
        async restore(choice: RestoreChoice): Promise<void> {
          if (await act('restore', 'backups.restore.failed', () => backupsApi.restore(choice))) {
            toast.success(translator.t('backups.restore.started'));
            reload();
          }
        },

        /** After a restore back where it was: the app's restored files applied, as the person. */
        async applyRestored(restore: BackupRestore): Promise<void> {
          const project = store.plan()?.items.find((i) => i.id === restore.itemId)?.project;
          const app = store.apps().find((a) => a.name === project);
          if (!app?.folder) {
            toast.error(translator.t('backups.restore.applyFailed'));
            return;
          }
          const folder = app.folder;
          if (
            await act(`apply:${restore.id}`, 'backups.restore.applyFailed', () =>
              backupsApi.applyRestored(restore.id, folder),
            )
          ) {
            toast.success(translator.t('backups.restore.applyStarted'));
            reload();
          }
        },

        async discardPrevious(restoreId: string): Promise<void> {
          if (
            await act(`discard:${restoreId}`, 'backups.restore.discardFailed', () =>
              backupsApi.discardPrevious(restoreId),
            )
          ) {
            toast.success(translator.t('backups.restore.discarded'));
            reload();
          }
        },

        loadOutput: rxMethod<string>(
          pipe(
            mergeMap((runId) =>
              backupsApi.runOutput(runId).pipe(
                tap(({ output }) =>
                  patchState(store, { outputs: { ...store.outputs(), [runId]: output } }),
                ),
                catchError(() => {
                  patchState(store, { outputs: { ...store.outputs(), [runId]: [] } });
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),

        /**
         * The folder picker: the starting places, or inside a folder; the latest click wins. Read
         * as the signed-in Linux account: its sign-in asked for first (closed: nothing changes).
         */
        browse: rxMethod<string | undefined>(
          pipe(
            switchMap((path) =>
              from(linuxSessionStore.asPerson(() => firstValueFrom(backupsApi.folders(path)))).pipe(
                tap((folders) => {
                  if (folders) patchState(store, { folders });
                }),
                catchError((error: unknown) => {
                  failed('backups.folders.failed', error);
                  return EMPTY;
                }),
              ),
            ),
          ),
        ),

        closeBrowser(): void {
          patchState(store, { folders: null });
        },

        setTab(tab: BackupsTab): void {
          patchState(store, { tab });
        },

        openSheet(itemId: string): void {
          patchState(store, { sheetItemId: itemId });
        },

        closeSheet(): void {
          patchState(store, { sheetItemId: null });
        },
      };
    },
  ),
  withHooks(
    (store, monitoringStore = inject(MonitoringStore), backupsStore = inject(BackupsStore)) => {
      let stop: (() => void) | null = null;
      return {
        onInit() {
          stop = monitoringStore.watch(['containers']);
          store.load();
          // What the topic says changed (a run ended, a restore moved on, setup elsewhere): reload.
          // The key is a string, so the effect runs only when it really changes.
          const changes = computed(() => {
            const status = backupsStore.status();
            return status
              ? [
                  status.configured,
                  status.lastRun?.id,
                  status.lastRun?.status,
                  status.restore?.id,
                  status.restore?.status,
                  status.running?.runId,
                ].join('|')
              : null;
          });
          let seen: string | null = null;
          effect(() => {
            const key = changes();
            if (key === null || key === seen) return;
            if (seen !== null) untracked(() => store.reload());
            seen = key;
          });
        },
        onDestroy() {
          stop?.();
        },
      };
    },
  ),
);
