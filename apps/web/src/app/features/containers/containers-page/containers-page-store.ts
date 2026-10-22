import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import type { ContainerActionParams } from '@laris/shared';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';

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
