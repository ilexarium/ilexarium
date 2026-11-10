import { Component, input, output, signal } from '@angular/core';
import type { AppSummary, BackupFoldersResponse } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBox, lucideFolderPlus, lucidePlus } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import type { ItemLabel, ItemRow } from '../backups.model';
import { FolderPicker } from '../folder-picker/folder-picker';
import { ItemCard } from '../item-card/item-card';

/**
 * What's backed up: a card per item, then a dashed "Add to backups" tile (the apps not in yet, a
 * folder); below, items removed earlier whose backups are kept. UI only: every action goes out
 * through an output.
 */
@Component({
  selector: 'ilex-backup-items',
  imports: [FolderPicker, HlmButton, HlmDropdownMenuImports, ItemCard, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideBox, lucideFolderPlus, lucidePlus })],
  host: { class: 'grid gap-6' },
  templateUrl: './backup-items.html',
})
export class BackupItems {
  readonly active = input.required<ItemRow[]>();
  readonly removed = input<ItemRow[]>([]);
  readonly addable = input<AppSummary[]>([]);
  readonly labels = input<Map<string, ItemLabel>>(new Map());
  readonly pending = input<string[]>([]);
  /** The item being backed up now. */
  readonly runningItemId = input<string | null>(null);
  /** A run is going. */
  readonly runBusy = input(false);
  readonly folderListing = input<BackupFoldersResponse | null>(null);

  readonly openItem = output<string>();
  readonly runNow = output<string>();
  readonly restore = output<ItemRow>();
  readonly remove = output<ItemRow>();
  readonly addApp = output<string>();
  readonly addFolder = output<string>();
  readonly browse = output<string | undefined>();
  readonly closeBrowser = output<void>();

  protected readonly pickerOpen = signal(false);

  protected label(row: ItemRow): ItemLabel {
    return this.labels().get(row.item.id) ?? { text: '', ltr: false };
  }

  protected openPicker(): void {
    this.pickerOpen.set(true);
    this.browse.emit(undefined);
  }

  protected chooseFolder(path: string): void {
    this.pickerOpen.set(false);
    this.addFolder.emit(path);
  }

  protected closePicker(): void {
    this.pickerOpen.set(false);
    this.closeBrowser.emit();
  }
}
