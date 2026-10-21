import { Component, output, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import type { UnmountTarget } from '../disks.model';

/**
 * Confirming an unmount (its files stay; afterwards it can be unplugged) — or forgetting a disk
 * that isn't connected. UI only: the page opens it; the choice goes out through `confirm`.
 */
@Component({
  selector: 'laris-unmount-dialog',
  imports: [HlmAlertDialogImports, TranslatePipe],
  templateUrl: './unmount-dialog.html',
})
export class UnmountDialog {
  readonly confirm = output<UnmountTarget>();

  private readonly dialog = viewChild.required(HlmAlertDialog);
  protected readonly target = signal<UnmountTarget | null>(null);

  open(target: UnmountTarget): void {
    this.target.set(target);
    this.dialog().open();
  }

  protected confirmed(): void {
    const target = this.target();
    this.dialog().close();
    if (target) this.confirm.emit(target);
  }
}
