import { Component, inject, input, output, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { Formatter } from '../../../shared/format/formatter';

/**
 * Confirming an update, with the app's last backup beside it: Back up now and Update are separate
 * choices — nothing waits for the backup. UI only: the page opens it; the choice goes out.
 */
@Component({
  selector: 'ilex-update-dialog',
  imports: [HlmAlertDialogImports, HlmButton, TranslatePipe],
  templateUrl: './update-dialog.html',
})
export class UpdateDialog {
  readonly name = input.required<string>();
  /** It has a backup item (else: not in the backups). */
  readonly inBackups = input(false);
  /** When it was last backed up; null: never. */
  readonly lastBackup = input<string | null>(null);
  /** A backup runs: none can start meanwhile. */
  readonly backupRunning = input(false);
  /** This app's backup runs (it may stop the app): no update meanwhile. */
  readonly appBackingUp = input(false);
  readonly backUp = output<void>();
  readonly update = output<void>();

  protected readonly formatter = inject(Formatter);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  open(): void {
    this.dialog().open();
  }

  protected backUpChosen(): void {
    this.dialog().close();
    this.backUp.emit();
  }

  protected updateChosen(): void {
    this.dialog().close();
    this.update.emit();
  }
}
