import { Component, computed, inject, output, signal, viewChild } from '@angular/core';
import type { FileEntry, FileSummary } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';

/**
 * Confirming a delete — for a folder, with how much is in it (counted by the server; the delete
 * button waits for the count). UI only: the page opens it with the count's promise; the choice
 * goes out through `confirm`.
 */
@Component({
  selector: 'laris-file-delete-dialog',
  imports: [HlmAlertDialogImports, PluralPipe, TranslatePipe],
  templateUrl: './file-delete-dialog.html',
})
export class FileDeleteDialog {
  readonly confirm = output<FileEntry>();

  private readonly dialog = viewChild.required(HlmAlertDialog);
  private readonly formatter = inject(Formatter);
  protected readonly entry = signal<FileEntry | null>(null);
  /** Null while counting. */
  protected readonly summary = signal<FileSummary | null>(null);
  protected readonly size = computed(() => this.formatter.bytes(this.summary()?.bytes ?? 0));
  protected readonly count = computed(() => {
    const summary = this.summary();
    return summary ? summary.files + summary.folders : 0;
  });

  open(entry: FileEntry, summary: Promise<FileSummary>): void {
    this.entry.set(entry);
    this.summary.set(null);
    this.dialog().open();
    void summary.then(
      (value) => this.entry() === entry && this.summary.set(value),
      () => this.dialog().close(),
    );
  }

  protected confirmed(): void {
    const entry = this.entry();
    this.dialog().close();
    if (entry) this.confirm.emit(entry);
  }
}
