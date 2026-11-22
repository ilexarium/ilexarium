import { Component, input, output, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';

/**
 * Confirming a removal: its containers go (`docker compose down`), its files stay — deleting them
 * is a step of its own. UI only: the page opens it; the choice goes out through `remove`.
 */
@Component({
  selector: 'ilex-remove-dialog',
  imports: [HlmAlertDialogImports, TranslatePipe],
  templateUrl: './remove-dialog.html',
})
export class RemoveDialog {
  readonly name = input.required<string>();
  readonly remove = output<void>();

  private readonly dialog = viewChild.required(HlmAlertDialog);

  open(): void {
    this.dialog().open();
  }

  protected confirmed(): void {
    this.dialog().close();
    this.remove.emit();
  }
}
