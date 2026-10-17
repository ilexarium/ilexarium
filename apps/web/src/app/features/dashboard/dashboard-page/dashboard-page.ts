import { Component, inject } from '@angular/core';
import { HlmSkeleton } from '@ui/skeleton';
import { ContainersTable } from '../../../shared/containers-table/containers-table';
import { AlertsNotice } from '../alerts-notice/alerts-notice';
import { CpuCard } from '../cpu-card/cpu-card';
import { DiskList } from '../disk-list/disk-list';
import { HostSummary } from '../host-summary/host-summary';
import { MemoryCard } from '../memory-card/memory-card';
import { NetworkCard } from '../network-card/network-card';
import { TranslatePipe } from '@ngx-translate/core';
import { DashboardPageStore } from './dashboard-page-store';

/** The server at a glance, live: host, CPU, memory, network, storage, containers. UI only. */
@Component({
  selector: 'app-dashboard-page',
  imports: [
    AlertsNotice,
    ContainersTable,
    CpuCard,
    DiskList,
    HlmSkeleton,
    HostSummary,
    MemoryCard,
    NetworkCard,
    TranslatePipe,
  ],
  providers: [DashboardPageStore],
  templateUrl: './dashboard-page.html',
})
export class DashboardPage {
  protected readonly store = inject(DashboardPageStore);
}
