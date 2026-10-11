import { Component, computed, inject, input } from '@angular/core';
import type { DiskUsage } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { percentOf } from '../../../shared/format/format';
import { TranslatePipe } from '@ngx-translate/core';
import { Formatter } from '../../../shared/format/formatter';

/** At or above this, a disk is flagged as almost full. */
export const DISK_WARNING_PERCENT = 90;

@Component({
  selector: 'app-disk-list',
  imports: [HlmBadgeImports, HlmCardImports, HlmProgressImports, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideTriangleAlert })],
  templateUrl: './disk-list.html',
})
export class DiskList {
  readonly disks = input.required<DiskUsage[]>();
  private readonly formatter = inject(Formatter);

  protected readonly rows = computed(() =>
    this.disks().map((disk) => {
      const percent = percentOf(disk.usedBytes, disk.sizeBytes);
      return {
        ...disk,
        percent,
        percentText: this.formatter.percent(percent),
        warning: percent >= DISK_WARNING_PERCENT,
        used: this.formatter.bytes(disk.usedBytes),
        size: this.formatter.bytes(disk.sizeBytes),
        free: this.formatter.bytes(disk.sizeBytes - disk.usedBytes),
      };
    }),
  );
}
