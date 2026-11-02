import { Component, computed, inject, input, output } from '@angular/core';
import type { BackupRun } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { Sparkline } from '../../../shared/charts/sparkline/sparkline';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { Formatter } from '../../../shared/format/formatter';
import type { ItemLabel } from '../backups.model';
import { RunRow } from '../run-row/run-row';

/**
 * The run history, newest first, with a small line of what each run added. UI only: opening a
 * run asks for its output through `openOutput`.
 */
@Component({
  selector: 'laris-backup-history',
  imports: [EmptyState, RunRow, Sparkline, TranslatePipe],
  host: { class: 'grid gap-4' },
  templateUrl: './backup-history.html',
})
export class BackupHistory {
  readonly runs = input<BackupRun[] | null>(null);
  readonly outputs = input<Record<string, string[]>>({});
  readonly labels = input<Map<string, ItemLabel>>(new Map());
  /** What each run added, oldest first. */
  readonly sizeLine = input<(number | null)[]>([]);

  readonly openOutput = output<string>();

  protected readonly formatter = inject(Formatter);
  protected readonly series = computed(() => [
    { values: this.sizeLine(), color: 'var(--chart-1)' },
  ]);
  protected readonly lastAdded = computed(() => {
    const known = this.sizeLine().filter((v): v is number => v !== null);
    return known.length > 0 ? known[known.length - 1] : null;
  });
}
