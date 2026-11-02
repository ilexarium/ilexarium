import { Component, computed, inject, input, output } from '@angular/core';
import type { BackupRun } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { Formatter } from '../../../shared/format/formatter';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import { runAdded, runDone } from '../backup-runs';
import { RUN_STATUS_DOTS } from '../backups.constants';
import type { ItemLabel } from '../backups.model';

/**
 * One run in the history: when, by hand or scheduled, how it went, what it added, how many items
 * — opened, each item's part and the output. UI only: opening asks for the output (`opened`).
 */
@Component({
  selector: 'laris-run-row',
  imports: [StatusDot, TranslatePipe],
  host: { class: 'block' },
  templateUrl: './run-row.html',
})
export class RunRow {
  readonly run = input.required<BackupRun>();
  /** Its output, once loaded. */
  readonly output = input<string[] | null>(null);
  readonly labels = input<Map<string, ItemLabel>>(new Map());

  readonly opened = output<void>();

  protected readonly formatter = inject(Formatter);
  protected readonly dots = RUN_STATUS_DOTS;
  protected readonly added = computed(() => runAdded(this.run()));
  protected readonly done = computed(() => runDone(this.run()));

  protected toggled(event: Event): void {
    if ((event.target as HTMLDetailsElement).open && !this.output()) this.opened.emit();
  }
}
