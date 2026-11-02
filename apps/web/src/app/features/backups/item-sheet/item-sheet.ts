import { Component, computed, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchiveRestore, lucidePlay, lucideTrash2 } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmSheetImports } from '@ui/sheet';
import { LanguageService } from '../../../core/i18n/language';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';
import type { ItemChange, ItemLabel, ItemRow } from '../backups.model';

/**
 * An item's details in a side sheet, open while `row` is set: an app's folders (those not backed
 * up marked), stopped or kept running, what's skipped; Borg's warnings and the last error; Back up
 * now, Restore…, Remove. UI only: changes and actions go out, `closed` when it closes itself.
 */
@Component({
  selector: 'laris-item-sheet',
  imports: [HlmButton, HlmSheetImports, NgIcon, PluralPipe, TranslatePipe],
  providers: [provideIcons({ lucideArchiveRestore, lucidePlay, lucideTrash2 })],
  templateUrl: './item-sheet.html',
})
export class ItemSheet {
  /** The item shown; null: closed. */
  readonly row = input<ItemRow | null>(null);
  readonly label = input<ItemLabel>({ text: '', ltr: false });
  readonly runBusy = input(false);
  readonly pending = input<string[]>([]);

  readonly change = output<ItemChange>();
  readonly runNow = output<void>();
  readonly restore = output<void>();
  readonly remove = output<void>();
  readonly closed = output<void>();

  protected readonly formatter = inject(Formatter);
  private readonly languageService = inject(LanguageService);
  /** From the end of the line, like the page's own details. */
  protected readonly side = computed(() =>
    this.languageService.dir() === 'rtl' ? 'left' : 'right',
  );

  /** The app's folders: those backed up, and the others Docker shows. */
  protected readonly allFolders = computed(() => {
    const item = this.row()?.item;
    return item ? [...new Set([...item.folders, ...item.otherFolders])].sort() : [];
  });

  protected readonly changing = computed(() => {
    const id = this.row()?.item.id;
    return id !== undefined && this.pending().includes(`folders:${id}`);
  });

  protected dismissed(): void {
    if (this.row()) this.closed.emit();
  }

  protected toggleFolder(row: ItemRow, folder: string, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    const { folders } = row.item;
    this.change.emit({
      itemId: row.item.id,
      change: { folders: on ? [...folders, folder] : folders.filter((f) => f !== folder) },
    });
  }

  /** At least one folder stays on. */
  protected lastFolder(row: ItemRow, folder: string): boolean {
    return row.item.folders.length === 1 && row.item.folders[0] === folder;
  }

  protected setMode(row: ItemRow, event: Event): void {
    const mode = (event.target as HTMLSelectElement).value === 'live' ? 'live' : 'stop';
    this.change.emit({ itemId: row.item.id, change: { mode } });
  }

  protected removeSkip(row: ItemRow, skip: string): void {
    this.change.emit({
      itemId: row.item.id,
      change: { skip: row.item.skip.filter((s) => s !== skip) },
    });
  }
}
