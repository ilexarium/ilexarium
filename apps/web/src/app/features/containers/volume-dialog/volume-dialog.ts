import { Component, inject, output, signal, viewChild } from '@angular/core';
import type { UnusedVolume } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { Formatter } from '../../../shared/format/formatter';

/**
 * Confirming a volume's delete: its files go for good. No check whether its app still needs it
 * (that would need the Linux sign-in): one warning for all. UI only: the choice goes out through
 * `confirm`.
 */
@Component({
  selector: 'ilex-volume-dialog',
  imports: [HlmAlertDialogImports, TranslatePipe],
  templateUrl: './volume-dialog.html',
})
export class VolumeDialog {
  readonly confirm = output<string>();

  protected readonly formatter = inject(Formatter);
  private readonly dialog = viewChild.required(HlmAlertDialog);
  protected readonly volume = signal<UnusedVolume | null>(null);
  /** Null while it's being counted, or if it couldn't be. */
  protected readonly bytes = signal<number | null>(null);

  open(volume: UnusedVolume, bytes: number | null): void {
    this.volume.set(volume);
    this.bytes.set(bytes);
    this.dialog().open();
  }

  protected confirmed(): void {
    const volume = this.volume();
    this.dialog().close();
    if (volume) this.confirm.emit(volume.name);
  }
}
