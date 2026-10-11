import { Component, computed, input } from '@angular/core';
import type { DiskUsage } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { formatBytes, formatPercent, percentOf } from '../../../shared/format/format';

/** At or above this, a disk is flagged as almost full. */
export const DISK_WARNING_PERCENT = 90;

@Component({
  selector: 'app-disk-list',
  imports: [HlmBadgeImports, HlmCardImports, HlmProgressImports, NgIcon],
  providers: [provideIcons({ lucideTriangleAlert })],
  templateUrl: './disk-list.html',
})
export class DiskList {
  readonly disks = input.required<DiskUsage[]>();

  protected readonly rows = computed(() =>
    this.disks().map((disk) => {
      const percent = percentOf(disk.usedBytes, disk.sizeBytes);
      return {
        ...disk,
        percent,
        percentText: formatPercent(percent),
        warning: percent >= DISK_WARNING_PERCENT,
        used: formatBytes(disk.usedBytes),
        size: formatBytes(disk.sizeBytes),
        free: formatBytes(disk.sizeBytes - disk.usedBytes),
      };
    }),
  );
}
