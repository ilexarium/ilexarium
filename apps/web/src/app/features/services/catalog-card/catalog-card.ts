import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { CatalogEntrySummary, ServiceStatus } from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { catalogIconUrl } from '../../../core/services/services-api';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { SERVICE_STATUS_TONES } from '../services.constants';

/** One catalog entry: what it is, and Install (or its state if it's installed). */
@Component({
  selector: 'app-catalog-card',
  // Fills its grid cell, so the cards of a row line up.
  host: { class: 'block h-full' },
  imports: [StatusBadge, HlmButton, HlmCardImports, RouterLink, TranslatePipe],
  templateUrl: './catalog-card.html',
})
export class CatalogCard {
  protected readonly statusTones = SERVICE_STATUS_TONES;
  readonly entry = input.required<CatalogEntrySummary>();
  /** Its current state (live from the installed list), null if never installed. */
  readonly status = input<ServiceStatus | null>(null);

  protected readonly iconUrl = computed(() => catalogIconUrl(this.entry().id));
  /** Install, or install again after a removal or a failure (the previous settings come back). */
  protected readonly installable = computed(() => {
    const status = this.status();
    return status === null || status === 'removed' || status === 'failed';
  });
}
