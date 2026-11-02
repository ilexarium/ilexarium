import { Component, computed, input, output, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import type { ItemLabel, ItemRemoval, ItemRow } from '../backups.model';

/**
 * Confirming an item's removal from the backups (its backups kept, or deleted when ticked) — or,
 * for an item removed earlier, deleting its backups. UI only: the page opens it (`open`), the
 * confirmed choice goes out through `remove`.
 */
@Component({
  selector: 'laris-remove-item-dialog',
  imports: [HlmAlertDialogImports, TranslatePipe],
  templateUrl: './remove-item-dialog.html',
})
export class RemoveItemDialog {
  readonly labels = input<Map<string, ItemLabel>>(new Map());
  readonly remove = output<ItemRemoval>();

  private readonly dialog = viewChild.required(HlmAlertDialog);
  protected readonly removing = signal<{ row: ItemRow; deleteArchives: boolean } | null>(null);
  protected readonly name = computed(() => {
    const row = this.removing()?.row;
    return (row && this.labels().get(row.item.id)?.text) ?? '';
  });

  /** A removed item's backups can only be deleted. */
  open(row: ItemRow): void {
    this.removing.set({ row, deleteArchives: row.item.removed });
    this.dialog().open();
  }

  protected setDeleteArchives(event: Event): void {
    const removing = this.removing();
    if (removing) {
      this.removing.set({
        ...removing,
        deleteArchives: (event.target as HTMLInputElement).checked,
      });
    }
  }

  protected confirmed(): void {
    const removing = this.removing();
    this.dialog().close();
    if (removing)
      this.remove.emit({ itemId: removing.row.item.id, deleteArchives: removing.deleteArchives });
  }
}
