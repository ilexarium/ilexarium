import { Component, computed, inject, input, output } from '@angular/core';
import type { BackupDestination, BackupsStatus } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleX,
  lucideLoaderCircle,
  lucidePlay,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { Formatter } from '../../../shared/format/formatter';
import type { ItemLabel } from '../backups.model';

/**
 * Where backups stand: what needs attention, when everything was last backed up and when the
 * next run is, the disk's free space, a running backup's progress (scheduled ones too) — and
 * "Back up now". UI only: `runNow` reports the click.
 */
@Component({
  selector: 'laris-backup-overview',
  imports: [HlmAlertImports, HlmButton, HlmCardImports, HlmProgressImports, NgIcon, TranslatePipe],
  providers: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleX,
      lucideLoaderCircle,
      lucidePlay,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './backup-overview.html',
})
export class BackupOverview {
  readonly status = input.required<BackupsStatus>();
  /** The disk now; null when it isn't mounted. */
  readonly destination = input<BackupDestination | null>(null);
  readonly destinationPath = input.required<string>();
  /** What each item is called, by id. */
  readonly labels = input<Map<string, ItemLabel>>(new Map());
  readonly pending = input(false);

  readonly runNow = output<void>();

  protected readonly format = inject(Formatter);

  protected readonly running = computed(() => this.status().running);
  protected readonly done = computed(() => {
    const items = this.running()?.items ?? [];
    return items.filter((i) => i.state === 'done').length;
  });
  protected readonly total = computed(() => this.running()?.items.length ?? 0);
  protected readonly current = computed(
    () => this.running()?.items.find((i) => i.state === 'running') ?? null,
  );
  protected readonly usedPercent = computed(() => {
    const disk = this.destination();
    return disk && disk.totalBytes > 0
      ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)
      : 0;
  });
}
