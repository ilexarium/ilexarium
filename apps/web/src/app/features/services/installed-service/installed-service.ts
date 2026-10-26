import { Component, computed, DOCUMENT, inject, input, output, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type InstalledService, catalogIconPath } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucideLoaderCircle, lucideTrash2 } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { JobProgress } from '../../../shared/job-progress/job-progress';
import { Formatter } from '../../../shared/format/formatter';
import { serviceUrl } from '../../../core/services/service-runtimes';
import type { ServiceRuntime } from '../../../core/services/services.model';
import type { ServiceBackup } from '../services.model';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { RUNTIME_TONES } from '../services.constants';

@Component({
  selector: 'laris-installed-service',
  // Fills its grid cell, so the cards of a row line up.
  host: { class: 'block h-full' },
  imports: [
    HlmAlertDialogImports,
    StatusBadge,
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
  protected readonly runtimeTones = RUNTIME_TONES;
  readonly service = input.required<InstalledService>();
  /** Null while the containers aren't known yet (or Docker isn't reachable). */
  readonly runtime = input<ServiceRuntime | null>(null);
  /** Null until backups are set up (then every service has a state). */
  readonly backup = input<ServiceBackup | null>(null);

  /** Remove was confirmed. */
  readonly remove = output<void>();

  private readonly location = inject(DOCUMENT).location;
  protected readonly formatter = inject(Formatter);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  protected readonly iconUrl = computed(() => catalogIconPath(this.service().catalogId));
  protected readonly busy = computed(() =>
    ['installing', 'removing'].includes(this.service().status),
  );
  protected readonly canRemove = computed(() =>
    ['installed', 'failed'].includes(this.service().status),
  );

  protected readonly openUrl = computed(() => serviceUrl(this.service(), this.location.hostname));

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
