import { Component, DestroyRef, inject } from '@angular/core';
import { MonitoringStore } from '../../../core/monitoring/monitoring-store';
import { ContainersTable } from '../../../shared/containers-table/containers-table';

/** Every container, running or stopped, with an actions menu each (View logs, …). */
@Component({
  selector: 'app-containers-page',
  imports: [ContainersTable],
  templateUrl: './containers-page.html',
})
export class ContainersPage {
  protected readonly store = inject(MonitoringStore);

  constructor() {
    const stop = this.store.watch(['containers']);
    inject(DestroyRef).onDestroy(stop);
  }
}
