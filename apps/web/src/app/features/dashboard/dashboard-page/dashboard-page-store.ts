import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import type { ContainerActionParams } from '@laris/shared';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

export const DashboardPageStore = signalStore(
  withComputed(
    (
      _,
      monitoringStore = inject(MonitoringStore),
      containerActionsStore = inject(ContainerActionsStore),
      alertsStore = inject(AlertsStore),
    ) => ({
      system: computed(() => monitoringStore.system()),
      /** The shell follows the alerts all along; the page only reads them. */
      alerts: computed(() => alertsStore.open()),
      containers: computed(() => monitoringStore.containers()),
      pending: computed(() => containerActionsStore.pending()),
    }),
  ),
  withMethods((_, containerActionsStore = inject(ContainerActionsStore)) => ({
    act({ name, action }: ContainerActionParams): void {
      void containerActionsStore.run(name, action);
    },
  })),
  withHooks((_, monitoringStore = inject(MonitoringStore)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        stop = monitoringStore.watch(['system', 'containers']);
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
