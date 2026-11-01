import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withHooks, withMethods } from '@ngrx/signals';
import type { ContainerActionParams } from '@laris/shared';
import { ContainerActionsStore } from '../../../core/containers/container-actions-store';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { groupByApp, needsAttention } from '../container-groups';
import { headline } from '../../../shared/headline/headline';
import type { Headline } from '../../../shared/headline/headline.model';
import type { ContainerGroup } from '../containers.model';

export const ContainersPageStore = signalStore(
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
