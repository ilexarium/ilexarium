import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import type { ContainerActionRequest } from '../../../core/containers/containers.model';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

/**
 * The Containers page's data, provided by the page and gone with it: every container, live (the
 * `containers` topic while the page is open), and their actions.
 */
export const ContainersPageStore = signalStore(
  withComputed(
    (_, monitoring = inject(MonitoringStore), actions = inject(ContainerActionsStore)) => ({
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
        stop = monitoring.watch(['containers']);
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
