import { computed, effect, inject, untracked } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import type {
  BackupArchive,
  BackupDestination,
  BackupFoldersResponse,
  BackupItem,
  BackupPlan,
  BackupPlanUpdate,
  BackupRestore,
  BackupRun,
  BackupItemUpdate,
  BackupSetupRequest,
} from '@laris/shared';
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
  lastValueFrom,
  merge,
  mergeMap,
  type Observable,
  pipe,
  switchMap,
  tap,
} from 'rxjs';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { Translator } from '../../../core/i18n/translator';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppsStore } from '../../../core/apps/apps-store';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import type { ItemChange, ItemRemoval, ItemRow, RestoreChoice } from '../backups.model';

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

    /** The plan's items as shown: active ones and removed ones (backups kept). */
    rows: computed((): { active: ItemRow[]; removed: ItemRow[] } => {
      const row = (item: BackupItem): ItemRow => ({ item, name: item.project });
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
  })),
  withMethods(
    (
      store,
      backupsApi = inject(BackupsApi),
      appsApi = inject(AppsApi),
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
          return (await linuxSessionStore.asPerson(() => firstValueFrom(request()))) !== null;
        } catch (error) {
          failed(failureKey, error, params);
          return false;
        } finally {
          pending(key, false);
        }
      }

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

        /** Sets backups up, as the person; rejects with the server's error (the form puts it on its fields). */
        async setup(request: BackupSetupRequest): Promise<void> {
          const answer = await linuxSessionStore.asPerson(() =>
            firstValueFrom(backupsApi.setup(request)),
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
            if (answer) patchState(store, { passphrase: answer.passphrase, passphraseFirst: false });
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

        /** An app, with its template's preset (how, and what to skip) when it has one. */
        async addApp(name: string): Promise<void> {
          const app = store.apps().find((a) => a.name === name);
          if (!app) return;
          let mode: 'stop' | 'live' = 'stop';
          let skip: string[] = [];
          if (app.template && app.folder) {
            const preset = await firstValueFrom(appsApi.template(app.template.id)).catch(() => null);
            mode = preset?.template.backup?.mode ?? mode;
            skip = (preset?.template.backup?.skip ?? []).map((s) => `${app.folder}/${s}`);
          }
          if (
            await act(`add:${name}`, 'backups.items.addFailed', () =>
              backupsApi.addItem({ kind: 'app', project: name, folders: [], skip, mode }),
            )
          ) {
            reload();
          }
        },

        async addFolder(path: string): Promise<void> {
          if (
            await act(
              `add:${path}`,
              'backups.items.addFailed',
              () => backupsApi.addItem({ kind: 'folder', path }),
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
            await act(`remove:${itemId}`, failure, () => backupsApi.removeItem(itemId, deleteArchives))
          ) {
            reload();
          }
        },

        /** The archives for the restore dialog; another item opened meanwhile wins. */
        loadArchives: rxMethod<string>(
          pipe(
            tap((itemId) => patchState(store, { archives: { itemId, list: null } })),
            switchMap((itemId) =>
              backupsApi.archives(itemId).pipe(
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

        async discardPrevious(restoreId: string): Promise<void> {
          if (
            await act(
              `discard:${restoreId}`,
              'backups.restore.discardFailed',
              () => backupsApi.discardPrevious(restoreId),
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

        /** The folder picker: the starting places, or inside a folder; the latest click wins. */
        browse: rxMethod<string | undefined>(
          pipe(
            switchMap((path) =>
              backupsApi.folders(path).pipe(
                tap((folders) => patchState(store, { folders })),
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
      };
    },
  ),
  withHooks((store, monitoringStore = inject(MonitoringStore), backupsStore = inject(BackupsStore)) => {
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
  }),
);
