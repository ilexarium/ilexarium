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
  type AppImage,
  type AppRemovalItem,
  type AppStarted,
  type AppTask,
  type FieldKind,
  parseEnv,
  setEnvValues,
} from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, firstValueFrom, map, pipe, switchMap, tap } from 'rxjs';
import { AppsApi } from '../../../core/apps/apps-api';
import { AppsStore } from '../../../core/apps/apps-store';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { Translator } from '../../../core/i18n/translator';
import { LinuxSessionStore } from '../../../core/linux/linux-session-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { apiErrorCode, apiErrorText } from '../../../shared/forms/submission-errors';
import { BACKUP_WAIT_MS } from '../apps.constants';
import type { VersionList } from '../apps.model';
import { followTask } from '../task-follower';

interface AppPageState {
  name: string;
  folderHint: string | null;
  details: AppDetails | null;
  /** Why it couldn't be read (an error code), or null. */
  loadError: string | null;
  /** Being edited (the files as read, until saved). */
  compose: string;
  env: string;
  kinds: Record<string, FieldKind>;
  versions: Record<string, VersionList>;
  /** Saved with other files on disk meanwhile: reload, or overwrite. */
  conflict: boolean;
  busy: boolean;
  task: AppTask | null;
  lines: string[];
  removal: AppRemovalItem[] | null;
  /** Removed: back to the list. */
  removed: boolean;
}

const initialState: AppPageState = {
  name: '',
  folderHint: null,
  details: null,
  loadError: null,
  compose: '',
  env: '',
  kinds: {},
  versions: {},
  conflict: false,
  busy: false,
  task: null,
  lines: [],
  removal: null,
  removed: false,
};

/**
 * One app's page: its files read as the signed-in Linux account (fresh each time), the form and
 * the editor, Update, the versions, the template's newer version, the backup, the removal — each
 * change done as the person, its task followed live.
 */
export const AppPageStore = signalStore(
  withState<AppPageState>(initialState),
  withComputed(
    (
      store,
      appsStore = inject(AppsStore),
      backupsStore = inject(BackupsStore),
      containerActionsStore = inject(ContainerActionsStore),
    ) => ({
      /** Live from the containers topic, else as read with the files. */
      summary: computed(
        () =>
          appsStore.apps()?.find((app) => app.name === store.name()) ??
          store.details()?.app ??
          null,
      ),
      values: computed(() => parseEnv(store.env())),
      shownFields: computed(() =>
        (store.details()?.fields ?? []).map((field) => ({
          ...field,
          kind: store.kinds()[field.key] ?? field.kind,
        })),
      ),
      versionLists: computed(() => new Map(Object.entries(store.versions()))),
      changed: computed(() => {
        const details = store.details();
        return !!details && (details.compose !== store.compose() || details.env !== store.env());
      }),
      templateNewer: computed(() => {
        const template = store.details()?.template;
        return !!template?.current && Number(template.current) > Number(template.version);
      }),
      backup: computed(() => backupsStore.apps().get(store.name()) ?? null),
      backupsConfigured: backupsStore.configured,
      running: computed(() => store.task()?.state === 'running'),
      pending: computed(() => {
        const pending = containerActionsStore.pending();
        return (store.details()?.app.containers ?? []).some((name) => pending.has(name));
      }),
      folder: computed(() => store.details()?.folder ?? store.folderHint() ?? ''),
    }),
  ),
  withMethods(
    (
      store,
      appsApi = inject(AppsApi),
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
                  task: store.task() ?? details.task,
                  lines: store.task() ? store.lines() : (details.task?.output ?? []),
                }),
              ),
              catchError((error: unknown) => {
                patchState(store, { loadError: apiErrorCode(error) ?? 'failed' });
                return EMPTY;
              }),
            ),
          ),
        ),
      );

      const follow = rxMethod<{ started: AppStarted; then?: () => Promise<void> | void }>(
        pipe(
          switchMap(({ started, then }) =>
            followTask(appsApi, started.name, started.folder).pipe(map((task) => ({ task, then }))),
          ),
          tap(({ task, then }) => {
            patchState(store, { task, lines: [...store.lines(), ...task.output] });
            if (task.state === 'running') return;
            if (task.state === 'succeeded') void then?.();
            if (!store.removed()) load();
          }),
        ),
      );

      const started = (result: AppStarted | null, then?: () => Promise<void> | void) => {
        if (!result) return;
        patchState(store, { task: result.task, lines: [] });
        follow({ started: result, then });
      };

      /** As the person; `busy` meanwhile; the error worded under `key`. */
      const asPerson = async <T>(key: string, action: () => Promise<T>): Promise<T | null> => {
        patchState(store, { busy: true });
        try {
          return await linuxSessionStore.asPerson(action);
        } catch (error) {
          failed(key, error);
          return null;
        } finally {
          patchState(store, { busy: false });
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
        for (const deadline = Date.now() + BACKUP_WAIT_MS; Date.now() < deadline; ) {
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
          patchState(store, { ...initialState, name, folderHint: folder });
          load();
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

        setKind(key: string, kind: FieldKind): void {
          patchState(store, { kinds: { ...store.kinds(), [key]: kind } });
        },

        setCompose(compose: string): void {
          patchState(store, { compose });
        },

        setEnv(env: string): void {
          patchState(store, { env });
        },

        async askVersions(image: string): Promise<void> {
          const set = (list: VersionList) =>
            patchState(store, { versions: { ...store.versions(), [image]: list } });
          set({ loading: true, versions: [], available: true });
          try {
            const { versions, available } = await firstValueFrom(appsApi.versions(image));
            set({ loading: false, versions, available });
          } catch {
            set({ loading: false, versions: [], available: false });
          }
        },

        /** Saves both files and applies them; `overwrite` after "changed on disk". */
        async save(overwrite = false): Promise<void> {
          const details = store.details();
          if (!details) return;
          patchState(store, { conflict: false });
          patchState(store, { busy: true });
          try {
            started(
              await linuxSessionStore.asPerson(() =>
                firstValueFrom(
                  appsApi.save(store.name(), {
                    folder: details.folder,
                    compose: store.compose(),
                    env: store.env(),
                    hash: details.hash,
                    overwrite,
                  }),
                ),
              ),
            );
          } catch (error) {
            if (apiErrorCode(error) === APP_ERROR_CODES.changedOnDisk) {
              patchState(store, { conflict: true });
            } else {
              failed('apps.save.failed', error);
            }
          } finally {
            patchState(store, { busy: false });
          }
        },

        async update(backupFirst: boolean): Promise<void> {
          if (backupFirst && !(await backUpFirst())) {
            toast.error(translator.t('apps.update.notBackedUp', { name: store.name() }));
            return;
          }
          started(
            await asPerson('apps.update.failed', () =>
              firstValueFrom(appsApi.update(store.name(), store.folder())),
            ),
          );
        },

        /** A pasted file's fixed tag: its `image:` line changed, then Update. */
        async changeTag(image: AppImage, tag: string): Promise<void> {
          started(
            await asPerson('apps.update.failed', () =>
              firstValueFrom(
                appsApi.imageTag(store.name(), { folder: store.folder(), service: image.service, tag }),
              ),
            ),
          );
        },

        /** "Undo this update": the versions it ran before, filled in (saved by the person). */
        fillPrevious(): void {
          const before = store.details()?.beforeUpdate;
          if (!before) return;
          const values: Record<string, string> = {};
          for (const field of store.details()?.fields ?? []) {
            const image = before.images.find((i) => field.image && i.image.endsWith(field.image));
            if (field.kind === 'version' && image) values[field.key] = `${image.tag}@${image.digest}`;
          }
          patchState(store, { env: setEnvValues(store.env(), values) });
          toast.info(translator.t('apps.undo.filled'));
        },

        async useTemplate(): Promise<void> {
          const details = await asPerson('apps.template.failed', () =>
            firstValueFrom(appsApi.useTemplate(store.name(), store.folder())),
          );
          if (!details) return;
          patchState(store, { details, compose: details.compose, env: details.env });
          toast.success(translator.t('apps.template.done'));
        },

        async addToBackups(): Promise<void> {
          const mode = store.details()?.template ? undefined : 'stop';
          const item = await asPerson('apps.backup.failed', () =>
            firstValueFrom(
              backupsApi.addItem({
                kind: 'app',
                project: store.name(),
                folders: [],
                skip: [],
                mode: mode ?? 'stop',
              }),
            ),
          );
          if (item) toast.success(translator.t('apps.backup.added', { name: store.name() }));
        },

        async act(action: 'start' | 'stop'): Promise<void> {
          const summary = store.details()?.app;
          if (summary) await containerActionsStore.runAll(summary.containers, action, store.name());
        },

        async openRemoval(): Promise<void> {
          patchState(store, { removal: null });
          const removal = await asPerson('apps.remove.failed', () =>
            firstValueFrom(appsApi.removal(store.name(), store.folder())),
          );
          if (removal) patchState(store, { removal: removal.items });
        },

        /** `docker compose down`, then what was ticked deleted. */
        async remove(ticked: AppRemovalItem[]): Promise<void> {
          const folder = store.folder();
          const remove = async () => {
            if (ticked.length > 0) {
              const done = await asPerson('apps.remove.deleteFailed', () =>
                firstValueFrom(
                  appsApi.delete(store.name(), {
                    folder,
                    settings: ticked.some((i) => i.kind === 'settings'),
                    folders: ticked.filter((i) => i.kind === 'folder').map((i) => i.path),
                    volumes: ticked.filter((i) => i.kind === 'volume').map((i) => i.path),
                  }),
                ).then(() => true),
              );
              if (!done) return;
            }
            toast.success(translator.t('apps.remove.done', { name: store.name() }));
            patchState(store, { removed: true });
          };
          started(
            await asPerson('apps.remove.failed', () =>
              firstValueFrom(appsApi.remove(store.name(), folder)),
            ),
            remove,
          );
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
