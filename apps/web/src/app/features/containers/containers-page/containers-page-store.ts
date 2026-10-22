import type { ContainerActionParams } from '@laris/shared';
import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

/**
 * The Containers page's data, provided by the page and gone with it: every container, live (the
 * `containers` topic while the page is open), and their containerActionsStore.
 */
export const ContainersPageStore = signalStore(
  withComputed(
    (
      _,
      monitoringStore = inject(MonitoringStore),
      containerActionsStore = inject(ContainerActionsStore),
    ) => ({
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
        stop = monitoringStore.watch(['containers']);
      },
      onDestroy() {
        stop?.();
      },
    };
  }),
);
