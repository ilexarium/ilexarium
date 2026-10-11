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
  templateUrl: './dashboard-page.html',
})
export class DashboardPage {
  protected readonly store = inject(MonitoringStore);

  constructor() {
    const stop = this.store.watch(['system', 'containers']);
    inject(DestroyRef).onDestroy(stop);
  }
}
