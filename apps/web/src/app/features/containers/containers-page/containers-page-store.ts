import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import type { ContainerActionParams } from '@laris/shared';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { needsAttention } from '../container-groups';
import type { ContainersHeadline } from '../containers.model';

export const ContainersPageStore = signalStore(
  withComputed(
    (
      _,
      monitoringStore = inject(MonitoringStore),
      containerActionsStore = inject(ContainerActionsStore),
    ) => ({
      containers: computed(() => monitoringStore.containers()),
      pending: computed(() => containerActionsStore.pending()),
      /** None before the first snapshot, without Docker or without containers: the table says so. */
      headline: computed<ContainersHeadline | null>(() => {
        const snapshot = monitoringStore.containers();
        if (!snapshot?.dockerAvailable || snapshot.containers.length === 0) return null;
        const { containers } = snapshot;
        const total = containers.length;
        const attention = containers.filter(needsAttention).length;
        if (attention > 0) return { key: 'containers.headline.attention', count: attention, total };
        const running = containers.filter((c) => c.state === 'running').length;
        return running === total
          ? { key: 'containers.headline.allRunning', count: total, total }
          : { key: 'containers.headline.someRunning', count: running, total };
      }),
    }),
  ),
  withMethods((_, containerActionsStore = inject(ContainerActionsStore)) => ({
    act(request: ContainerActionParams): void {
      void containerActionsStore.run(request);
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
