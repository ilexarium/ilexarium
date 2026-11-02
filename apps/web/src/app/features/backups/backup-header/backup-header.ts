import { Component, computed, inject, input, output } from '@angular/core';
import type { BackupDestination, BackupsStatus } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleX,
  lucideEllipsis,
  lucideHardDrive,
  lucideKeyRound,
  lucideLoaderCircle,
  lucidePlay,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmProgressImports } from '@ui/progress';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';
import { DISK_PATH_SHOWN } from '../backups.constants';
import type { BackupsHeadline } from '../backups.model';

/**
 * The top of the Backups page: the headline, the next run, Back up now and "⋯" (the passphrase
 * again), the disk tile, and the warnings as a band. UI only: the clicks go out.
 */
@Component({
  selector: 'laris-backup-header',
  imports: [
    HlmButton,
    HlmDropdownMenuImports,
    HlmProgressImports,
    NgIcon,
    PluralPipe,
    TranslatePipe,
  ],
  providers: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleX,
      lucideEllipsis,
      lucideHardDrive,
      lucideKeyRound,
      lucideLoaderCircle,
      lucidePlay,
      lucideTriangleAlert,
    }),
  ],
  host: { class: 'grid gap-4' },
  templateUrl: './backup-header.html',
})
export class BackupHeader {
  readonly headline = input<BackupsHeadline | null>(null);
  readonly status = input.required<BackupsStatus>();
  /** The disk now; null when it isn't mounted. */
  readonly destination = input<BackupDestination | null>(null);
  readonly destinationPath = input.required<string>();
  readonly pending = input(false);

  readonly runNow = output<void>();
  readonly showPassphrase = output<void>();

  protected readonly formatter = inject(Formatter);
  protected readonly shownPath = computed(() => {
    const path = this.destinationPath();
    return path.length > DISK_PATH_SHOWN ? `…/${path.split('/').filter(Boolean).at(-1)}` : path;
  });
  protected readonly running = computed(() => this.status().running !== null);
  protected readonly usedPercent = computed(() => {
    const disk = this.destination();
    return disk && disk.totalBytes > 0
      ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)
      : 0;
  });
}
