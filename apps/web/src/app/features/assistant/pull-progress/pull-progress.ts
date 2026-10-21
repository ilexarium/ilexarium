import { Component, computed, inject, input } from '@angular/core';
import type { AiPull } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmProgressImports } from '@ui/progress';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';

/** A model download: its bar while it runs, then how it ended. Presentational. */
@Component({
  selector: 'laris-pull-progress',
  imports: [HlmProgressImports, StatusBadge, TranslatePipe],
  host: { class: 'grid gap-2 rounded-lg border p-3' },
  templateUrl: './pull-progress.html',
})
export class PullProgress {
  readonly pull = input.required<AiPull>();

  protected readonly format = inject(Formatter);
  protected readonly percent = computed(() => {
    const { completedBytes, totalBytes } = this.pull();
    return totalBytes > 0 ? Math.min(100, (completedBytes / totalBytes) * 100) : 0;
  });
}
