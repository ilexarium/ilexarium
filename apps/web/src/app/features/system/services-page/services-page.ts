import { Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch, lucideX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { ServiceList } from '../service-list/service-list';
import { ServiceSheet } from '../service-sheet/service-sheet';
import { GROUPS } from './services-page.constants';
import { ServicesPageStore } from './services-page-store';

/**
 * The Services page (docs/plans/system_services.md): the host's systemd services, failed first,
 * with a summary that filters; a service's details in a sheet; start, stop and restart through
 * the signed-in Linux account's sudo.
 */
@Component({
  selector: 'ilex-services-page',
  imports: [
    EmptyState,
    HlmAlertImports,
    HlmButton,
    HlmInput,
    HlmSkeleton,
    NgIcon,
    PluralPipe,
    ServiceList,
    ServiceSheet,
    TranslatePipe,
  ],
  providers: [ServicesPageStore, provideIcons({ lucideSearch, lucideX })],
  templateUrl: './services-page.html',
})
export class ServicesPage {
  protected readonly servicesPageStore = inject(ServicesPageStore);
  protected readonly groups = GROUPS;

  protected search(event: Event): void {
    this.servicesPageStore.setSearch((event.target as HTMLInputElement).value);
  }

  protected showInactive(event: Event): void {
    this.servicesPageStore.setShowInactive((event.target as HTMLInputElement).checked);
  }
}
