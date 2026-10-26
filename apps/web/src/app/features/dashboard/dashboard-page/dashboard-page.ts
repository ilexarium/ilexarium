import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { ActivityCard } from '../activity-card/activity-card';
import { AppsCard } from '../apps-card/apps-card';
import { BackupsCard } from '../backups-card/backups-card';
import { DiskList } from '../disk-list/disk-list';
import { MetricTiles } from '../metric-tiles/metric-tiles';
import { StatusRack } from '../status-rack/status-rack';
import { DashboardPageStore } from './dashboard-page-store';

@Component({
  selector: 'laris-dashboard-page',
  imports: [
    ActivityCard,
    AppsCard,
    BackupsCard,
    DiskList,
    HlmSkeleton,
    MetricTiles,
    PluralPipe,
    RouterLink,
    StatusRack,
    TranslatePipe,
  ],
  providers: [DashboardPageStore],
  templateUrl: './dashboard-page.html',
})
export class DashboardPage {
  protected readonly store = inject(DashboardPageStore);
}
