import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import type { ContainerActionRequest } from '../../../core/containers/containers.model';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

export const DashboardPageStore = signalStore(
  withComputed(
    (
      _,
      monitoring = inject(MonitoringStore),
      actions = inject(ContainerActionsStore),
      alerts = inject(AlertsStore),
    ) => ({
      system: computed(() => monitoring.system()),
      /** The shell follows the alerts all along; the page only reads them. */
      alerts: computed(() => alerts.open()),
      containers: computed(() => monitoring.containers()),
      pending: computed(() => actions.pending()),
    }),
  ),
  withMethods((_, actions = inject(ContainerActionsStore)) => ({
    act({ name, action }: ContainerActionRequest): void {
      void actions.run(name, action);
    },
  })),
  withHooks((_, monitoring = inject(MonitoringStore)) => {
    let stop: (() => void) | null = null;
    return {
      onInit() {
        stop = monitoring.watch(['system', 'containers']);
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
