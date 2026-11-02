import { Component, computed, input } from '@angular/core';
import type { BackupProgress } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmProgressImports } from '@ui/progress';
import type { ItemLabel } from '../backups.model';

/** A backup running (scheduled ones too): how far, the item and its phase, the output folded. */
@Component({
  selector: 'laris-run-progress',
  imports: [HlmProgressImports, TranslatePipe],
  host: { class: 'block' },
  templateUrl: './run-progress.html',
})
export class RunProgress {
  readonly run = input.required<BackupProgress>();
  readonly labels = input<Map<string, ItemLabel>>(new Map());

  protected readonly done = computed(
    () => this.run().items.filter((i) => i.state === 'done').length,
  );
  protected readonly total = computed(() => this.run().items.length);
  protected readonly current = computed(
    () => this.run().items.find((i) => i.state === 'running') ?? null,
  );
}
