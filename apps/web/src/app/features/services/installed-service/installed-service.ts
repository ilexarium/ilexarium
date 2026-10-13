import { Component, computed, DOCUMENT, inject, input, output, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { InstalledService } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucideLoaderCircle, lucideTrash2 } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { catalogIconUrl } from '../../../core/services/services-api';
import { JobProgress } from '../job-progress/job-progress';
import type { ServiceRuntime } from '../services.model';

/**
 * One installed service: its state, an Open link to its web page, Remove (after a confirmation —
 * its data and settings stay), and the progress of a running job or what went wrong in the last.
 * UI only: it reports a confirmed Remove through `remove`; the page's store does it.
 */
@Component({
  selector: 'app-installed-service',
  // Fills its grid cell, so the cards of a row line up.
  host: { class: 'block h-full' },
  imports: [
    HlmAlertDialogImports,
    HlmBadgeImports,
    HlmButton,
    HlmCardImports,
    JobProgress,
    NgIcon,
    RouterLink,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideExternalLink, lucideLoaderCircle, lucideTrash2 })],
  templateUrl: './installed-service.html',
})
export class InstalledServiceCard {
  readonly service = input.required<InstalledService>();
  /** Null while the containers aren't known yet (or Docker isn't reachable). */
  readonly runtime = input<ServiceRuntime | null>(null);

  /** Remove was confirmed. */
  readonly remove = output<void>();

  private readonly location = inject(DOCUMENT).location;
  private readonly dialog = viewChild.required(HlmAlertDialog);

  protected readonly iconUrl = computed(() => catalogIconUrl(this.service().catalogId));
  protected readonly busy = computed(() =>
    ['installing', 'removing'].includes(this.service().status),
  );
  protected readonly canRemove = computed(() =>
    ['installed', 'failed'].includes(this.service().status),
  );

  /** The web page of the service: same host as this app, its own port. Plain HTTP (inside your network). */
  protected readonly openUrl = computed(() => {
    const port = this.service().webPort;
    if (this.service().status !== 'installed' || port === null) return null;
    return `http://${this.location.hostname}:${port}/`;
  });

  /** The latest job, while it runs or if it didn't succeed. */
  protected readonly job = computed(() => {
    const job = this.service().job;
    return job && job.status !== 'succeeded' ? job : null;
  });

  protected confirmRemove(): void {
    this.dialog().open();
  }

  protected confirmed(): void {
    this.dialog().close();
    this.remove.emit();
  }
}
