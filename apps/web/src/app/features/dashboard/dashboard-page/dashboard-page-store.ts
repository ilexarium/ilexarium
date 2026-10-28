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
import type { ActivityItem, BackupRun } from '@laris/shared';
import {
  catchError,
  debounce,
  defer,
  EMPTY,
  type Observable,
  pipe,
  switchMap,
  tap,
  timer,
} from 'rxjs';
import { ActivityApi } from '../../../core/activity/activity-api';
import { alertTitle } from '../../../core/alerts/alert-wording';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { BackupsApi } from '../../../core/backups/backups-api';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { RealtimeService } from '../../../core/realtime/realtime-service';
import { AppsStore } from '../../../core/apps/apps-store';
import { Formatter } from '../../../shared/format/formatter';
import { ACTIVITY_RELOAD_MS, CLOCK_MS } from '../dashboard.constants';
import type { AppTile } from '../dashboard.model';
import { LOADING_KEY } from './dashboard-status';
import {
  appTiles,
  backupDays,
  needsAttention,
  otherContainers,
  rackUnits,
  type RackWords,
  shownDisks,
} from './dashboard-status';

interface DashboardPageState {
  /** Null until loaded (and while backups aren't set up). */
  runs: BackupRun[] | null;
  /** Where the backups go; null until loaded or without a plan. */
  destination: string | null;
  /** Null until loaded; stays as it was when a reload fails. */
  activity: ActivityItem[] | null;
  /** The page's clock (epoch ms), moved every minute: "3 hours ago", the strip's days. */
  now: number;
}

const initialState = (): DashboardPageState => ({
  runs: null,
  destination: null,
  activity: null,
  now: Date.now(),
});

/** The first time at once, then once a burst of changes has settled. */
const settled =
  <T>() =>
  (source: Observable<T>) =>
    defer(() => {
      let first = true;
      return source.pipe(
        debounce(() => {
          const wait = first ? 0 : ACTIVITY_RELOAD_MS;
          first = false;
          return timer(wait);
        }),
      );
    });

export const DashboardPageStore = signalStore(
  withState<DashboardPageState>(initialState),
  withComputed(
    (
      store,
      monitoringStore = inject(MonitoringStore),
      appsStore = inject(AppsStore),
      backupsStore = inject(BackupsStore),
      alertsStore = inject(AlertsStore),
      containerActionsStore = inject(ContainerActionsStore),
      realtimeService = inject(RealtimeService),
      formatter = inject(Formatter),
    ) => {
      const words: RackWords = {
        alertTitle: (alert) => alertTitle(alert, formatter),
        bytes: (bytes) => formatter.bytes(bytes),
        ago: (at) => formatter.ago(at, store.now()),
        dateTime: (at) => formatter.dateTime(at),
        percent: (percent) => formatter.percent(percent),
        machine: (name) => (typeof name === 'string' ? formatter.machine(name) : name),
      };
      const system = computed(() => monitoringStore.system());
      const containers = computed(() => {
        const snapshot = monitoringStore.containers();
        return snapshot?.dockerAvailable ? snapshot.containers : null;
      });
      const docker = computed(() => monitoringStore.containers()?.dockerAvailable !== false);
      const apps = computed(() => appsStore.apps());
      const disks = computed(() => {
        const snapshot = system();
        return snapshot ? shownDisks(snapshot.disks, store.destination()) : null;
      });
      const units = computed(() =>
        rackUnits(
          {
            alerts: alertsStore.open(),
            apps: apps(),
            docker: docker(),
            backups: backupsStore.status(),
            disks: disks(),
          },
          words,
        ),
      );
      return {
        system,
        disks,
        units,
        attention: computed(() => needsAttention(units())),
        /** Some unit doesn't know yet: the sentence waits instead of saying all is well. */
        checking: computed(() => units().some((unit) => unit.text.key === LOADING_KEY)),
        alertCount: computed(() => alertsStore.open().length),
        live: computed(() => realtimeService.status() === 'live'),
        appsLoaded: computed(() => apps() !== null),
        apps: computed(() => appTiles(apps() ?? [], containers(), containerActionsStore.pending())),
        otherContainers: computed(() => {
          const list = containers();
          return list ? otherContainers(list) : 0;
        }),
        backups: computed(() => backupsStore.status()),
        backupDays: computed(() => {
          const runs = store.runs();
          return runs ? backupDays(runs, new Date(store.now())) : null;
        }),
        /** Changes after which the backup runs are fetched again: a run started or finished. */
        runsKey: computed(() => {
          const status = backupsStore.status();
          if (!status?.configured) return null;
          return `${status.lastRun?.id}:${status.lastRun?.status}:${status.running?.runId ?? ''}`;
        }),
        /** Changes after which the activity is fetched again. */
        activityKey: computed(() =>
          [
            alertsStore
              .open()
              .map((a) => a.id)
              .join(','),
            alertsStore.closed()[0]?.id ?? '',
            backupsStore.status()?.lastRun?.id ?? '',
            backupsStore.status()?.lastRun?.status ?? '',
            (apps() ?? []).map((app) => `${app.name}:${app.state}`).join(','),
            [...containerActionsStore.pending().keys()].join(','),
            // Anything else (a disk mounted elsewhere, another person's action) within a minute.
            store.now(),
          ].join('|'),
        ),
      };
    },
  ),
  withMethods(
    (
      store,
      backupsApi = inject(BackupsApi),
      activityApi = inject(ActivityApi),
      containerActionsStore = inject(ContainerActionsStore),
    ) => ({
      loadRuns: rxMethod<string | null>(
        pipe(
          switchMap((key) => {
            if (key === null) {
              patchState(store, { runs: null });
              return EMPTY;
            }
            return backupsApi.runs().pipe(
              tap(({ runs }) => patchState(store, { runs })),
              catchError(() => EMPTY),
            );
          }),
        ),
      ),

      loadPlan: rxMethod<boolean>(
        pipe(
          switchMap((configured) =>
            !configured
              ? EMPTY
              : backupsApi.plan().pipe(
                  tap(({ plan }) => patchState(store, { destination: plan?.destination ?? null })),
                  catchError(() => EMPTY),
                ),
          ),
        ),
      ),

      loadActivity: rxMethod<string>(
        pipe(
          settled(),
          switchMap(() =>
            activityApi.recent().pipe(
              tap(({ items }) => patchState(store, { activity: items })),
              catchError(() => EMPTY),
            ),
          ),
        ),
      ),

      /** Starts an app's stopped containers (harmless: no confirmation). */
      async start(app: AppTile): Promise<void> {
        await containerActionsStore.runAll(app.stopped, 'start', app.app.name);
      },
    }),
  ),
  withHooks(
    (
      store,
      monitoringStore = inject(MonitoringStore),
      backupsStore = inject(BackupsStore),
    ) => {
      const stops: (() => void)[] = [];
      return {
        onInit() {
          stops.push(monitoringStore.watch(['system', 'containers']));
          store.loadRuns(store.runsKey);
          store.loadPlan(backupsStore.configured);
          store.loadActivity(store.activityKey);
          const clock = setInterval(() => patchState(store, { now: Date.now() }), CLOCK_MS);
          stops.push(() => clearInterval(clock));
        },
        onDestroy() {
          for (const stop of stops) stop();
        },
      };
    },
  ),
);
