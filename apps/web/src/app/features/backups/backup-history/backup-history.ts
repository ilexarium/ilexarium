import { Component, inject, input, output } from '@angular/core';
import type { BackupRun } from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadgeImports } from '@ui/badge';
import { HlmCardImports } from '@ui/card';
import { Formatter } from '../../../shared/format/formatter';
import type { ItemLabel } from '../backups.model';

/**
 * The run history, newest first: when, scheduled or by hand, how it went, each item's part, and
 * its output when opened. UI only: opening a run asks for its output through `openOutput`.
 */
@Component({
  selector: 'app-backup-history',
  imports: [HlmBadgeImports, HlmCardImports, TranslatePipe],
  templateUrl: './backup-history.html',
})
export class BackupHistory {
  readonly runs = input<BackupRun[] | null>(null);
  readonly outputs = input<Record<string, string[]>>({});
  readonly labels = input<Map<string, ItemLabel>>(new Map());

  readonly openOutput = output<string>();

  protected readonly format = inject(Formatter);

  protected toggled(run: BackupRun, event: Event): void {
    if ((event.target as HTMLDetailsElement).open && !this.outputs()[run.id]) {
      this.openOutput.emit(run.id);
    }
  }
}
