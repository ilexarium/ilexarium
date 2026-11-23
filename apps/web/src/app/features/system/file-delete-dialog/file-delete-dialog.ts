import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import type { FileEntry } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';
import type { FileDeletion } from '../files.model';

/**
 * Confirming a delete — for a folder, with how much is in it (counted by the server; the delete
 * button waits for the count). UI only: shown while the page store has a delete to confirm; the
 * choice goes out through `confirm`, any other close through `cancel`.
 */
@Component({
  selector: 'ilex-file-delete-dialog',
  imports: [HlmAlertDialogImports, PluralPipe, TranslatePipe],
  templateUrl: './file-delete-dialog.html',
})
export class FileDeleteDialog {
  readonly deleting = input.required<FileDeletion | null>();
  readonly confirm = output<FileEntry>();
  readonly cancel = output<void>();

  private readonly formatter = inject(Formatter);
  /** The delete asked about, kept while the dialog closes (so it doesn't go blank). */
  private readonly shown = linkedSignal<FileDeletion | null, FileDeletion | null>({
    source: this.deleting,
    computation: (deleting, previous) => deleting ?? previous?.value ?? null,
  });
  protected readonly entry = computed(() => this.shown()?.entry ?? null);
  /** Null while counting. */
  protected readonly summary = computed(() => this.shown()?.summary ?? null);
  protected readonly size = computed(() => this.formatter.bytes(this.summary()?.bytes ?? 0));
  protected readonly count = computed(() => {
    const summary = this.summary();
    return summary ? summary.files + summary.folders : 0;
  });

  protected confirmed(): void {
    const entry = this.entry();
    if (entry) this.confirm.emit(entry);
  }

  /** Closed without Delete (Cancel, Escape): as soon as it starts closing. */
  protected stateChanged(state: 'open' | 'closed'): void {
    if (state === 'closed' && this.deleting()) this.cancel.emit();
  }
}
