import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { ContainersTable } from '../../../shared/containers-table/containers-table';
import { ContainersPageStore } from './containers-page-store';

@Component({
  selector: 'laris-containers-page',
  imports: [ContainersTable, HlmButton, RouterLink, TranslatePipe],
  providers: [ContainersPageStore],
  templateUrl: './containers-page.html',
})
export class ContainersPage {
  protected readonly store = inject(ContainersPageStore);
}
