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
  BackupSetupRequest,
  CatalogEntrySummary,
} from '@laris/shared';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { toast } from '@spartan-ng/brain/sonner';
import {
  catchError,
  concat,
  defer,
  EMPTY,
  exhaustMap,
  finalize,
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
import { ServicesApi } from '../../../core/services/services-api';
import { ServicesStore } from '../../../core/services/services-store';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import type { BackupableService, ItemRow, RestoreChoice } from '../backups.model';

interface BackupsPageState {
  /** Null while loading (`loaded` false) or before setup. */
  plan: BackupPlan | null;
  loaded: boolean;
  failed: boolean;
  destinations: BackupDestination[] | null;
  catalog: CatalogEntrySummary[] | null;
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
  catalog: null,
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
 * The Backups page's data, provided by the page and gone with it: the plan and its items (with
 * names from the catalog), the disks, run history, restores, the folder picker, and every action
 * with its toast. Live parts (the running run, the latest restore, warnings) come from the global
 * `BackupsStore`; when they change, the page reloads what they affect.
 */
export const BackupsPageStore = signalStore(
  withState<BackupsPageState>(initialState),
  withComputed((store, backupsStore = inject(BackupsStore)) => ({
    status: computed(() => backupsStore.status()),
    running: computed(() => backupsStore.running()),
    catalogById: computed(() => new Map((store.catalog() ?? []).map((entry) => [entry.id, entry]))),
  })),
  withComputed((store, servicesStore = inject(ServicesStore)) => ({
    /** Installed services whose recipe has a backup. */
    backupable: computed((): BackupableService[] => {
      const catalog = store.catalogById();
      return (servicesStore.services() ?? [])
        .filter(
          (s) =>
            s.status === 'installed' && (catalog.get(s.catalogId)?.backupFolders.length ?? 0) > 0,
        )
        .map((s) => ({
          id: s.id,
          catalogId: s.catalogId,
          name: s.name,
          folders: catalog.get(s.catalogId)!.backupFolders,
        }));
    }),

    /** The plan's items as shown: active ones and removed ones (backups kept). */
    rows: computed((): { active: ItemRow[]; removed: ItemRow[] } => {
      const catalog = store.catalogById();
      const row = (item: BackupItem): ItemRow => ({
        item,
        name: item.catalogId ? (catalog.get(item.catalogId)?.name ?? item.catalogId) : null,
        folders: item.catalogId ? (catalog.get(item.catalogId)?.backupFolders ?? []) : [],
      });
      const items = store.plan()?.items ?? [];
      return {
        active: items.filter((i) => !i.removed).map(row),
        removed: items.filter((i) => i.removed).map(row),
      };
    }),
  })),
  withComputed((store) => ({
    /** Installed services with a backup that aren't in the plan yet. */
    addable: computed(() => {
      const inPlan = new Set(
        store
          .rows()
          .active.map((r) => r.item.serviceId)
          .filter((id): id is string => !!id),
      );
      return store.backupable().filter((s) => !inPlan.has(s.id));
    }),
  })),
  withMethods(
    (
      store,
      backupsApi = inject(BackupsApi),
      servicesApi = inject(ServicesApi),
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

      /** An action with a pending marker; a failure is a toast. Emits once it succeeded. */
      const act = <T>(key: string, failureKey: string, request: Observable<T>, params = {}) =>
        defer(() => {
          pending(key, true);
          return request;
        }).pipe(
          catchError((error: unknown) => {
            failed(failureKey, error, params);
            return EMPTY;
          }),
          finalize(() => pending(key, false)),
        );

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
      const catalog$ = () =>
        servicesApi.catalog().pipe(
          tap((catalog) => patchState(store, { catalog })),
          catchError(() => EMPTY),
        );
      const destinations$ = () =>
        backupsApi.destinations().pipe(
          tap(({ destinations }) => patchState(store, { destinations })),
          catchError(() => {
            patchState(store, { destinations: [] });
            return EMPTY;
          }),
        );

      // After a change: the latest answer wins.
      const loadPlan = rxMethod<void>(pipe(switchMap(plan$)));
      const loadHistory = rxMethod<void>(pipe(switchMap(history$)));

      return {
        load: rxMethod<void>(
          pipe(exhaustMap(() => concat(plan$(), merge(catalog$(), destinations$(), history$())))),
        ),

        /** After a change pushed by the topic: the plan and the history again. */
        reload: rxMethod<void>(pipe(switchMap(() => concat(plan$(), history$())))),

        /** Sets backups up; rejects with the server's error (the form puts it on its fields). */
        async setup(request: BackupSetupRequest): Promise<void> {
          const { passphrase } = await firstValueFrom(backupsApi.setup(request));
          patchState(store, { passphrase, passphraseFirst: true });
          // The form stays busy until the plan shows.
          await lastValueFrom(plan$(), { defaultValue: undefined });
          toast.success(translator.t('backups.setup.done'));
        },

        /** The passphrase was saved by the user: it goes from the page. */
        hidePassphrase(): void {
          patchState(store, { passphrase: null, passphraseFirst: false });
        },

        /** "Show again"; rejects with the server's error (wrong password: on its field). */
        async showPassphrase(password: string): Promise<void> {
          const { passphrase } = await firstValueFrom(backupsApi.passphrase(password));
          patchState(store, { passphrase, passphraseFirst: false });
        },

        /** Saves schedule, retention or disk; rejects with the server's error. */
        async updatePlan(update: BackupPlanUpdate): Promise<void> {
          const plan = await firstValueFrom(backupsApi.updatePlan(update));
          patchState(store, { plan });
          toast.success(translator.t('backups.settings.saved'));
        },

        runNow: rxMethod<string | undefined>(
          pipe(
            mergeMap((itemId) =>
              act(
                itemId ? `run:${itemId}` : 'run',
                'backups.run.failed',
                backupsApi.runNow(itemId),
              ).pipe(tap(() => toast.success(translator.t('backups.run.started')))),
            ),
          ),
        ),

        addService: rxMethod<string>(
          pipe(
            mergeMap((serviceId) =>
              act(
                `add:${serviceId}`,
                'backups.items.addFailed',
                backupsApi.addItem({ kind: 'service', serviceId }),
              ).pipe(tap(() => loadPlan())),
            ),
          ),
        ),

        addFolder: rxMethod<string>(
          pipe(
            mergeMap((path) =>
              act(
                `add:${path}`,
                'backups.items.addFailed',
                backupsApi.addItem({ kind: 'folder', path }),
              ).pipe(
                tap(() => {
                  patchState(store, { folders: null });
                  loadPlan();
                }),
              ),
            ),
          ),
        ),

        setFolders: rxMethod<{ itemId: string; excludedFields: string[] }>(
          pipe(
            mergeMap(({ itemId, excludedFields }) =>
              act(
                `folders:${itemId}`,
                'backups.items.foldersFailed',
                backupsApi.updateItem(itemId, excludedFields),
              ).pipe(tap(() => loadPlan())),
            ),
          ),
        ),

        /** Out of the plan (already confirmed); `deleteArchives` deletes its backups too. */
        removeItem: rxMethod<{ itemId: string; deleteArchives: boolean }>(
          pipe(
            mergeMap(({ itemId, deleteArchives }) =>
              act(
                `remove:${itemId}`,
                deleteArchives ? 'backups.items.deleteFailed' : 'backups.items.removeFailed',
                backupsApi.removeItem(itemId, deleteArchives),
              ).pipe(tap(() => loadPlan())),
            ),
          ),
        ),

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
        restore: rxMethod<RestoreChoice>(
          pipe(
            exhaustMap((choice) =>
              act('restore', 'backups.restore.failed', backupsApi.restore(choice)).pipe(
                tap(() => {
                  toast.success(translator.t('backups.restore.started'));
                  loadHistory();
                }),
              ),
            ),
          ),
        ),

        discardPrevious: rxMethod<string>(
          pipe(
            mergeMap((restoreId) =>
              act(
                `discard:${restoreId}`,
                'backups.restore.discardFailed',
                backupsApi.discardPrevious(restoreId),
              ).pipe(
                tap(() => {
                  toast.success(translator.t('backups.restore.discarded'));
                  loadHistory();
                }),
              ),
            ),
          ),
        ),

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
  withHooks((store, servicesStore = inject(ServicesStore), backupsStore = inject(BackupsStore)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        stop = servicesStore.watch();
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
                status.restore?.job.status,
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
