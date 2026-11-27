import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import { isSkipInFolders, isSkipPatternUsable } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchiveRestore, lucidePlay, lucideTrash2 } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmSheetImports } from '@ui/sheet';
import { LanguageService } from '../../../core/i18n/language';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';
import type { ItemChange, ItemLabel, ItemRow } from '../backups.model';

/**
 * An item's details in a side sheet, open while `row` is set: an app's folders (those not backed
 * up marked), stopped or kept running; what's skipped in an app's or a folder item's folders (and
 * a subfolder to skip); Borg's warnings and the last error; Back up now, Restore…, Remove. UI
 * only: changes and actions go out, `closed` when it closes itself.
 */
@Component({
  selector: 'ilex-item-sheet',
  imports: [HlmButton, HlmInput, HlmSheetImports, NgIcon, PluralPipe, TranslatePipe],
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

  protected readonly skipFolders = computed(() => {
    const item = this.row()?.item;
    if (item?.kind === 'app') return item.folders;
    return item?.kind === 'folder' && item.path ? [item.path] : [];
  });

  /** A subfolder to skip: typed below one of the folders backed up (the first, until chosen). */
  private readonly itemId = computed(() => this.row()?.item.id ?? null);
  protected readonly newSkip = linkedSignal({ source: this.itemId, computation: () => '' });
  private readonly chosenSkipFolder = linkedSignal<string | null, string | null>({
    source: this.itemId,
    computation: () => null,
  });
  /** The folder chosen while it's still backed up; the first one otherwise. */
  protected readonly skipFolder = computed(() => {
    const folders = this.skipFolders();
    const chosen = this.chosenSkipFolder();
    return chosen && folders.includes(chosen) ? chosen : (folders[0] ?? '');
  });
  /** Why the typed skip was refused: a translation key, or null. */
  protected readonly skipError = linkedSignal<string | null, string | null>({
    source: this.itemId,
    computation: () => null,
  });

  protected readonly changing = computed(() => {
    const id = this.row()?.item.id;
    return id !== undefined && this.pending().includes(`folders:${id}`);
  });

  protected dismissed(): void {
    if (this.row()) this.closed.emit();
  }

  // The controls go back to the saved value at once: the change shows once it's saved (a
  // refused one, or a closed sudo prompt, leaves them as they were).
  protected toggleFolder(row: ItemRow, folder: string, event: Event): void {
    const box = event.target as HTMLInputElement;
    const on = box.checked;
    box.checked = !on;
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
    const select = event.target as HTMLSelectElement;
    const mode = select.value === 'live' ? 'live' : 'stop';
    select.value = row.item.mode ?? 'stop';
    this.change.emit({ itemId: row.item.id, change: { mode } });
  }

  protected typeSkip(event: Event): void {
    this.newSkip.set((event.target as HTMLInputElement).value);
    this.skipError.set(null);
  }

  protected chooseSkipFolder(event: Event): void {
    this.chosenSkipFolder.set((event.target as HTMLSelectElement).value);
  }

  /** The server checks it too; here, so a mistake is said at the field. */
  protected addSkip(row: ItemRow): void {
    const below = this.newSkip()
      .trim()
      .replace(/^\.?\/+/, '');
    if (!below) return;
    const skip = `${this.skipFolder()}/${below}`;
    if (!isSkipInFolders(skip, this.skipFolders())) {
      this.skipError.set(
        isSkipPatternUsable(skip, this.skipFolders())
          ? 'validation.backupSkipInvalid'
          : 'validation.backupSkipPatternFolder',
      );
      return;
    }
    if (!row.item.skip.includes(skip)) {
      this.change.emit({ itemId: row.item.id, change: { skip: [...row.item.skip, skip] } });
    }
    this.newSkip.set('');
  }

  protected removeSkip(row: ItemRow, skip: string): void {
    this.change.emit({
      itemId: row.item.id,
      change: { skip: row.item.skip.filter((s) => s !== skip) },
    });
  }
}
