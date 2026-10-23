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
import { toast } from '@spartan-ng/brain/sonner';
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

      /** Runs an action with a pending marker; a failure is a toast. Resolves true on success. */
      async function act(
        key: string,
        failureKey: string,
        run: () => Promise<unknown>,
        params = {},
      ) {
        pending(key, true);
        try {
          await run();
          return true;
        } catch (error) {
          failed(failureKey, error, params);
          return false;
        } finally {
          pending(key, false);
        }
      }

      async function loadPlan(): Promise<void> {
        try {
          const { plan } = await backupsApi.plan();
          patchState(store, { plan, loaded: true, failed: false });
        } catch {
          patchState(store, { loaded: true, failed: true });
        }
      }

      async function loadHistory(): Promise<void> {
        if (!store.plan()) return;
        try {
          const [{ runs }, { restores }] = await Promise.all([
            backupsApi.runs(),
            backupsApi.restores(),
          ]);
          patchState(store, { runs, restores });
        } catch {
          // The page shows the last known history; the next change tries again.
        }
      }

      return {
        async load(): Promise<void> {
          await loadPlan();
          await Promise.all([
            servicesApi
              .catalog()
              .then((catalog) => patchState(store, { catalog }))
              .catch(() => undefined),
            this.loadDestinations(),
            loadHistory(),
          ]);
        },

        /** After a change pushed by the topic: the plan and the history again. */
        async reload(): Promise<void> {
          await loadPlan();
          await loadHistory();
        },

        async loadDestinations(): Promise<void> {
          try {
            patchState(store, { destinations: (await backupsApi.destinations()).destinations });
          } catch {
            patchState(store, { destinations: [] });
          }
        },

        /** Sets backups up; rejects with the server's error (the form puts it on its fields). */
        async setup(request: BackupSetupRequest): Promise<void> {
          const { passphrase } = await backupsApi.setup(request);
          patchState(store, { passphrase, passphraseFirst: true });
          await loadPlan();
          toast.success(translator.t('backups.setup.done'));
        },

        /** The passphrase was saved by the user: it goes from the page. */
        hidePassphrase(): void {
          patchState(store, { passphrase: null, passphraseFirst: false });
        },

        /** "Show again"; rejects with the server's error (wrong password: on its field). */
        async showPassphrase(password: string): Promise<void> {
          const { passphrase } = await backupsApi.passphrase(password);
          patchState(store, { passphrase, passphraseFirst: false });
        },

        /** Saves schedule, retention or disk; rejects with the server's error. */
        async updatePlan(update: BackupPlanUpdate): Promise<void> {
          const plan = await backupsApi.updatePlan(update);
          patchState(store, { plan });
          toast.success(translator.t('backups.settings.saved'));
        },

        async runNow(itemId?: string): Promise<void> {
          const key = itemId ? `run:${itemId}` : 'run';
          if (await act(key, 'backups.run.failed', () => backupsApi.runNow(itemId))) {
            toast.success(translator.t('backups.run.started'));
          }
        },

        async addService(serviceId: string): Promise<void> {
          if (
            await act(`add:${serviceId}`, 'backups.items.addFailed', () =>
              backupsApi.addItem({ kind: 'service', serviceId }),
            )
          ) {
            await loadPlan();
          }
        },

        async addFolder(path: string): Promise<void> {
          if (
            await act(`add:${path}`, 'backups.items.addFailed', () =>
              backupsApi.addItem({ kind: 'folder', path }),
            )
          ) {
            patchState(store, { folders: null });
            await loadPlan();
          }
        },

        async setFolders(itemId: string, excludedFields: string[]): Promise<void> {
          if (
            await act(`folders:${itemId}`, 'backups.items.foldersFailed', () =>
              backupsApi.updateItem(itemId, excludedFields),
            )
          ) {
            await loadPlan();
          }
        },

        /** Out of the plan (already confirmed); `deleteArchives` deletes its backups too. */
        async removeItem(itemId: string, deleteArchives: boolean): Promise<void> {
          const failure = deleteArchives
            ? 'backups.items.deleteFailed'
            : 'backups.items.removeFailed';
          if (
            await act(`remove:${itemId}`, failure, () =>
              backupsApi.removeItem(itemId, deleteArchives),
            )
          ) {
            await loadPlan();
          }
        },

        async loadArchives(itemId: string): Promise<void> {
          patchState(store, { archives: { itemId, list: null } });
          try {
            const { archives } = await backupsApi.archives(itemId);
            if (store.archives()?.itemId === itemId)
              patchState(store, { archives: { itemId, list: archives } });
          } catch {
            patchState(store, { archives: { itemId, list: [] } });
          }
        },

        /** Starts a restore (already confirmed); its progress arrives through the topic. */
        async restore(choice: RestoreChoice): Promise<void> {
          if (await act('restore', 'backups.restore.failed', () => backupsApi.restore(choice))) {
            toast.success(translator.t('backups.restore.started'));
            await loadHistory();
          }
        },

        async discardPrevious(restoreId: string): Promise<void> {
          if (
            await act(`discard:${restoreId}`, 'backups.restore.discardFailed', () =>
              backupsApi.discardPrevious(restoreId),
            )
          ) {
            toast.success(translator.t('backups.restore.discarded'));
            await loadHistory();
          }
        },

        async loadOutput(runId: string): Promise<void> {
          try {
            const { output } = await backupsApi.runOutput(runId);
            patchState(store, { outputs: { ...store.outputs(), [runId]: output } });
          } catch {
            patchState(store, { outputs: { ...store.outputs(), [runId]: [] } });
          }
        },

        /** The folder picker: the starting places, or inside a folder. */
        async browse(path?: string): Promise<void> {
          try {
            patchState(store, { folders: await backupsApi.folders(path) });
          } catch (error) {
            failed('backups.folders.failed', error);
          }
        },

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
        void store.load();
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
          if (key === null) return;
          if (seen !== null) untracked(() => void store.reload());
          seen = key;
        });
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
