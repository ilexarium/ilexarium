import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import { BackupsStore } from '../../../core/backups/backups-store';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import type { ContainerActionRequest } from '../../../core/containers/containers.model';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

/**
 * The dashboard's data, provided by the page and gone with it: the host and every container,
 * live (the `system` and `containers` topics while the page is open), container actions, and
 * the backups' warnings.
 */
export const DashboardPageStore = signalStore(
  withComputed(
    (
      _,
      monitoring = inject(MonitoringStore),
      actions = inject(ContainerActionsStore),
      backups = inject(BackupsStore),
    ) => ({
      system: computed(() => monitoring.system()),
      /** What needs attention in the backups (the shell follows their status all along). */
      backupWarnings: computed(() => backups.warnings()),
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
