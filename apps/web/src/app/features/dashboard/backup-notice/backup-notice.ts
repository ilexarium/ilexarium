import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { BackupWarning } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';

/** The backups' most serious problem on the dashboard, with a link to the Backups page. */
@Component({
  selector: 'app-backup-notice',
  imports: [HlmAlertImports, HlmButton, NgIcon, RouterLink, TranslatePipe],
  providers: [provideIcons({ lucideTriangleAlert })],
  templateUrl: './backup-notice.html',
})
export class BackupNotice {
  /** Most serious first; the first one is shown. */
  readonly warnings = input.required<BackupWarning[]>();
}
