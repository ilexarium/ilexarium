import { Component, inject } from '@angular/core';
import { ContainersTable } from '../../../shared/containers-table/containers-table';
import { ContainersPageStore } from './containers-page-store';

/** Every container, running or stopped, with an actions menu each (View logs, …). UI only. */
@Component({
  selector: 'app-containers-page',
  imports: [ContainersTable],
  providers: [ContainersPageStore],
  templateUrl: './containers-page.html',
})
export class ContainersPage {
  protected readonly store = inject(ContainersPageStore);
}
