import { Component, computed, inject, input } from '@angular/core';
import { ALERT_LIMITS, type DiskUsage } from '@laris/shared';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { percentOf } from '../../../shared/format/format';
import { TranslatePipe } from '@ngx-translate/core';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';

@Component({
  selector: 'laris-disk-list',
  imports: [HlmCardImports, HlmProgressImports, StatusBadge, TranslatePipe],
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
        // The alerts' limits: "Almost full" here exactly when the alert says so.
        warning: percent >= ALERT_LIMITS.diskFullPercent,
        critical: percent >= ALERT_LIMITS.diskCriticalPercent,
        used: this.formatter.bytes(disk.usedBytes),
        size: this.formatter.bytes(disk.sizeBytes),
        free: this.formatter.bytes(disk.sizeBytes - disk.usedBytes),
      };
    }),
  );
}
