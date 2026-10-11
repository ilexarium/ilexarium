import { Component, DestroyRef, inject } from '@angular/core';
import { HlmSkeleton } from '@ui/skeleton';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { ContainersTable } from '../../../shared/containers-table/containers-table';
import { CpuCard } from '../cpu-card/cpu-card';
import { DiskList } from '../disk-list/disk-list';
import { HostSummary } from '../host-summary/host-summary';
import { MemoryCard } from '../memory-card/memory-card';
import { NetworkCard } from '../network-card/network-card';

/** The server at a glance, live: host, CPU, memory, network, storage, containers. */
@Component({
  selector: 'app-dashboard-page',
  imports: [ContainersTable, CpuCard, DiskList, HostSummary, HlmSkeleton, MemoryCard, NetworkCard],
  template: `
    @if (store.system(); as system) {
      <div class="grid gap-4 md:gap-6">
        <app-host-summary [host]="system.host" [uptimeSeconds]="system.uptimeSeconds" />
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <app-cpu-card
            [cpu]="system.sample.cpu"
            [cores]="system.host.cpuCores"
            [history]="system.history"
          />
          <app-memory-card [memory]="system.sample.memory" [history]="system.history" />
          <app-network-card
            [interfaces]="system.sample.network"
            [history]="system.history"
            class="sm:col-span-2 xl:col-span-1"
          />
        </div>
        <app-disk-list [disks]="system.disks" />
        <app-containers-table [containers]="store.containers()" [now]="system.sample.at" />
      </div>
    } @else {
      <div class="grid gap-4 md:gap-6" role="status" aria-label="Loading server data">
        <hlm-skeleton class="h-5 w-2/3" />
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          @for (card of [1, 2, 3]; track card) {
            <hlm-skeleton class="h-44 rounded-xl" />
          }
        </div>
        <hlm-skeleton class="h-48 rounded-xl" />
      </div>
    }
  `,
})
export class DashboardPage {
  protected readonly store = inject(MonitoringStore);

  constructor() {
    const stop = this.store.watch(['system', 'containers']);
    inject(DestroyRef).onDestroy(stop);
  }
}
