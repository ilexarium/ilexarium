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
  template: `
    <section hlmCard aria-labelledby="storage-title">
      <div hlmCardHeader>
        <h2 hlmCardTitle id="storage-title">Storage</h2>
        <p hlmCardDescription>Space used on each disk</p>
      </div>
      <div hlmCardContent>
        @if (rows().length === 0) {
          <p class="text-sm text-muted-foreground">No disks found.</p>
        } @else {
          <ul class="grid gap-5">
            @for (disk of rows(); track disk.device) {
              <li class="grid gap-2" [attr.data-warning]="disk.warning || null">
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span class="min-w-0">
                    <span class="font-medium break-all">{{ disk.mount }}</span>
                    <span class="ms-2 text-sm text-muted-foreground break-all">
                      {{ disk.device }} · {{ disk.fsType }}
                    </span>
                  </span>
                  @if (disk.warning) {
                    <span hlmBadge variant="destructive">
                      <ng-icon name="lucideTriangleAlert" aria-hidden="true" />
                      Almost full
                    </span>
                  }
                </div>
                <hlm-progress
                  [value]="disk.percent"
                  [attr.aria-label]="'Space used on ' + disk.mount"
                >
                  <hlm-progress-indicator [class]="disk.warning ? 'bg-destructive' : ''" />
                </hlm-progress>
                <p class="text-sm text-muted-foreground tabular-nums">
                  {{ disk.used }} of {{ disk.size }} used ({{ disk.percentText }}) ·
                  {{ disk.free }} free
                </p>
              </li>
            }
          </ul>
        }
      </div>
    </section>
  `,
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
