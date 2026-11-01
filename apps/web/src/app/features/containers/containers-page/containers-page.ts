import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { HlmButton } from '@ui/button';
import { ContainersTable } from '../containers-table/containers-table';
import { ContainersPageStore } from './containers-page-store';

@Component({
  selector: 'laris-containers-page',
  imports: [ContainersTable, HlmButton, PluralPipe, RouterLink, TranslatePipe],
  providers: [ContainersPageStore],
  templateUrl: './containers-page.html',
})
export class ContainersPage {
  protected readonly store = inject(ContainersPageStore);
}
