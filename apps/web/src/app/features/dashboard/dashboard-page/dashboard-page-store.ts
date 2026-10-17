import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import type { ContainerActionRequest } from '../../../core/containers/containers.model';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

/**
 * The dashboard's data, provided by the page and gone with it: the host and every container,
 * live (the `system` and `containers` topics while the page is open), container actions, and
 * the open alerts.
 */
export const DashboardPageStore = signalStore(
  withComputed(
    (
      _,
      monitoring = inject(MonitoringStore),
      actions = inject(ContainerActionsStore),
      alerts = inject(AlertsStore),
    ) => ({
      system: computed(() => monitoring.system()),
      /** What needs attention, backups' warnings among it (the shell follows the alerts all along). */
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
