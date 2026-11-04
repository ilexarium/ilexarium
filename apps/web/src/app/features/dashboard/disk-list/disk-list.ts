import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideHardDrive, lucideShieldCheck } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { DISK_FAIL_PERCENT, DISK_WARN_PERCENT } from '../dashboard.constants';
import type { DiskRow } from '../dashboard.model';
import { diskName } from '../dashboard-page/dashboard-status';
import { TextPipe } from '../text-pipe';

/** The disks worth showing: how full each is, in words as well as a bar. */
@Component({
  selector: 'laris-disk-list',
  imports: [
    HlmCardImports,
    HlmProgressImports,
    NgIcon,
    RouterLink,
    StatusBadge,
    TextPipe,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideHardDrive, lucideShieldCheck })],
  host: { class: 'block' },
  templateUrl: './disk-list.html',
})
export class DiskList {
  readonly disks = input.required<DiskRow[]>();
  private readonly formatter = inject(Formatter);

  protected readonly rows = computed(() =>
    this.disks().map((disk) => ({
      ...disk,
      name: diskName(disk),
      icon: disk.kind === 'backup' ? 'lucideShieldCheck' : 'lucideHardDrive',
      level:
        disk.percent >= DISK_FAIL_PERCENT
          ? ('full' as const)
          : disk.percent >= DISK_WARN_PERCENT
            ? ('filling' as const)
            : null,
      usage: {
        used: this.formatter.bytes(disk.usedBytes),
        size: this.formatter.bytes(disk.sizeBytes),
        percent: this.formatter.percent(disk.percent),
      },
      free: this.formatter.bytes(disk.sizeBytes - disk.usedBytes),
    })),
  );
  /** A disk filling up: Docker's unused data may be the quickest space to win back. */
  protected readonly filling = computed(() => this.rows().some((disk) => disk.level !== null));
}
