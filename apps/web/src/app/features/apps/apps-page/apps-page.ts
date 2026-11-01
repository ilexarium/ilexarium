import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { AppCard } from '../app-card/app-card';
import { AppsPageStore } from './apps-page-store';

/** Apps: Compose folders, run as their owner's Linux account (docs/plans/acting_as_you.md). */
@Component({
  selector: 'laris-apps-page',
  imports: [
    AppCard,
    EmptyState,
    HlmButton,
    HlmSkeleton,
    NgIcon,
    PluralPipe,
    RouterLink,
    TranslatePipe,
  ],
  providers: [AppsPageStore, provideIcons({ lucidePlus })],
  templateUrl: './apps-page.html',
})
export class AppsPage {
  protected readonly appsPageStore = inject(AppsPageStore);
}
