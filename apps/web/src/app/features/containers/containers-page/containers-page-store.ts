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
import type { ContainerActionParams, DockerCleanup } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { catchError, EMPTY, exhaustMap, finalize, mergeMap, pipe, switchMap, tap } from 'rxjs';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { DockerCleanupApi } from '../../../core/containers/docker-cleanup-api';
import { Translator } from '../../../core/i18n/translator';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { Formatter } from '../../../shared/format/formatter';
import { apiErrorText } from '../../../shared/forms/submission-errors';
import { groupByApp, needsAttention } from '../container-groups';
import { headline } from '../../../shared/headline/headline';
import type { Headline } from '../../../shared/headline/headline.model';
import type { ContainerGroup } from '../containers.model';

interface ContainersPageState {
  /** What Docker keeps unused; null until it's read (or when it couldn't be). */
  cleanup: DockerCleanup | null;
  /** Volume sizes by name; null while Docker counts them. */
  volumeSizes: Record<string, number | null> | null;
  /** The sizes couldn't be counted. */
  volumeSizesFailed: boolean;
  /** Unused images and the build cache are being removed. */
  pruning: boolean;
  /** Volumes being deleted. */
  removing: string[];
}

const initialState: ContainersPageState = {
  cleanup: null,
  volumeSizes: null,
  volumeSizesFailed: false,
  pruning: false,
  removing: [],
};

/**
 * The Containers page's data: the containers (the `containers` topic, through the monitoring
 * store), their actions, and Docker's unused data with freeing it.
 */
export const ContainersPageStore = signalStore(
  withState<ContainersPageState>(initialState),
  withComputed(
    (
      _,
      monitoringStore = inject(MonitoringStore),
      containerActionsStore = inject(ContainerActionsStore),
    ) => ({
      containers: computed(() => monitoringStore.containers()),
      pending: computed(() => containerActionsStore.pending()),
      groups: computed<ContainerGroup[]>(() => {
        const snapshot = monitoringStore.containers();
        return snapshot?.dockerAvailable ? groupByApp(snapshot.containers) : [];
      }),
      /** None before the first snapshot, without Docker or without containers: the table says so. */
      headline: computed<Headline | null>(() => {
        const snapshot = monitoringStore.containers();
        if (!snapshot?.dockerAvailable || snapshot.containers.length === 0) return null;
        const { containers } = snapshot;
        return headline(
          'containers.headline',
          containers.length,
          containers.filter(needsAttention).length,
          containers.filter((c) => c.state === 'running').length,
        );
      }),
    }),
  ),
  withMethods((store, dockerCleanupApi = inject(DockerCleanupApi)) => ({
    /** The latest wins: a reload after freeing space replaces one still on its way. */
    _loadVolumeSizes: rxMethod<void>(
      pipe(
        tap(() => patchState(store, { volumeSizes: null, volumeSizesFailed: false })),
        switchMap(() =>
          dockerCleanupApi.volumeSizes().pipe(
            tap(({ sizes }) => patchState(store, { volumeSizes: sizes })),
            catchError(() => {
              patchState(store, { volumeSizesFailed: true });
              return EMPTY;
            }),
          ),
        ),
      ),
    ),
  })),
  withMethods((store, dockerCleanupApi = inject(DockerCleanupApi)) => ({
    /** Without Docker the card stays away: the table says Docker isn't reachable. */
    loadCleanup: rxMethod<void>(
      pipe(
        switchMap(() =>
          dockerCleanupApi.overview().pipe(
            tap((cleanup) => {
              patchState(store, { cleanup });
              // Counted again only for a volume it doesn't know: a delete or a prune keeps them.
              const names = cleanup.volumes.map((volume) => volume.name);
              const sizes = store.volumeSizes();
              if (names.length === 0) patchState(store, { volumeSizes: {} });
              else if (sizes && names.every((name) => name in sizes)) {
                patchState(store, {
                  volumeSizes: Object.fromEntries(names.map((name) => [name, sizes[name]])),
                });
              } else store._loadVolumeSizes();
            }),
            catchError(() => {
              patchState(store, { cleanup: null });
              return EMPTY;
            }),
          ),
        ),
      ),
    ),
  })),
  withMethods(
    (
      store,
      containerActionsStore = inject(ContainerActionsStore),
      dockerCleanupApi = inject(DockerCleanupApi),
      translator = inject(Translator),
      formatter = inject(Formatter),
    ) => ({
      act: rxMethod<ContainerActionParams>(tap((request) => containerActionsStore.run(request))),

      /** Every unused image and the build cache (already confirmed). */
      prune: rxMethod<void>(
        pipe(
          exhaustMap(() =>
            dockerCleanupApi.prune().pipe(
              tap({
                subscribe: () => patchState(store, { pruning: true }),
                next: ({ bytesFreed, buildCacheFailed }) => {
                  const size = formatter.bytes(bytesFreed);
                  if (buildCacheFailed) {
                    toast.warning(translator.t('containers.freeSpace.freedNotCache', { size }));
                  } else toast.success(translator.t('containers.freeSpace.freed', { size }));
                },
              }),
              catchError((error: unknown) => {
                toast.error(translator.t('containers.freeSpace.pruneFailed'), {
                  description: translator.t(...apiErrorText(error)),
                });
                return EMPTY;
              }),
              finalize(() => {
                patchState(store, { pruning: false });
                store.loadCleanup();
              }),
            ),
          ),
        ),
      ),

      /** One volume no container uses (already confirmed); volumes side by side. */
      removeVolume: rxMethod<string>(
        pipe(
          mergeMap((name) => {
            if (store.removing().includes(name)) return EMPTY;
            const params = { name: formatter.machine(name) };
            return dockerCleanupApi.removeVolume(name).pipe(
              tap({
                subscribe: () => patchState(store, { removing: [...store.removing(), name] }),
                complete: () =>
                  toast.success(translator.t('containers.freeSpace.volumeDeleted', params)),
              }),
              catchError((error: unknown) => {
                toast.error(translator.t('containers.freeSpace.volumeFailed', params), {
                  description: translator.t(...apiErrorText(error)),
                });
                return EMPTY;
              }),
              finalize(() => {
                patchState(store, { removing: store.removing().filter((n) => n !== name) });
                store.loadCleanup();
              }),
            );
          }),
        ),
      ),
    }),
  ),
  withHooks((store, monitoringStore = inject(MonitoringStore)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        stop = monitoringStore.watch(['containers']);
        store.loadCleanup();
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
