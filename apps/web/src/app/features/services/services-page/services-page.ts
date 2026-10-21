import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmSkeleton } from '@ui/skeleton';
import { CatalogCard } from '../catalog-card/catalog-card';
import { InstalledServiceCard } from '../installed-service/installed-service';
import { ServicesPageStore } from './services-page-store';
import { EmptyState } from '../../../shared/empty-state/empty-state';

/**
 * Installed services (live: state, running jobs, Open and Remove) and the catalog to install
 * from. UI only: the data and Remove live in its page store.
 */
@Component({
  selector: 'laris-services-page',
  imports: [EmptyState, CatalogCard, HlmSkeleton, InstalledServiceCard, TranslatePipe],
  providers: [ServicesPageStore],
  templateUrl: './services-page.html',
})
export class ServicesPage {
  protected readonly store = inject(ServicesPageStore);
}
