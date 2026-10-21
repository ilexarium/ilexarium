import { Component, inject, input, output, signal, viewChild } from '@angular/core';
import type { BackupFoldersResponse } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchiveRestore,
  lucideEllipsis,
  lucideFolderPlus,
  lucidePlay,
  lucidePlus,
  lucideTrash2,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';
import type { BackupableService, ItemLabel, ItemRow } from '../backups.model';
import { FolderPicker } from '../folder-picker/folder-picker';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { RUN_STATUS_TONES } from '../backups.constants';

/**
 * What's backed up: each item with its last backup, size and state, and its actions — Back up
 * now, Restore…, its folders (a service with several), Remove (its backups kept, or deleted when
 * ticked — confirmed). Below: services to add, a folder to add, and items removed earlier whose
 * backups are kept. UI only: every action goes out through an output.
 */
@Component({
  selector: 'laris-backup-items',
  imports: [
    FolderPicker,
    HlmAlertDialogImports,
    StatusBadge,
    HlmButton,
    HlmCardImports,
    HlmDropdownMenuImports,
    NgIcon,
    PluralPipe,
    TranslatePipe,
  ],
  providers: [
    provideIcons({
      lucideArchiveRestore,
      lucideEllipsis,
      lucideFolderPlus,
      lucidePlay,
      lucidePlus,
      lucideTrash2,
    }),
  ],
  templateUrl: './backup-items.html',
})
export class BackupItems {
  protected readonly statusTones = RUN_STATUS_TONES;
  readonly active = input.required<ItemRow[]>();
  readonly removed = input<ItemRow[]>([]);
  readonly addable = input<BackupableService[]>([]);
  readonly labels = input<Map<string, ItemLabel>>(new Map());
  readonly pending = input<string[]>([]);
  readonly running = input(false);
  readonly folderListing = input<BackupFoldersResponse | null>(null);

  readonly runNow = output<string>();
  readonly restore = output<ItemRow>();
  readonly setFolders = output<{ itemId: string; excludedFields: string[] }>();
  readonly remove = output<{ itemId: string; deleteArchives: boolean }>();
  readonly addService = output<string>();
  readonly addFolder = output<string>();
  readonly browse = output<string | undefined>();
  readonly closeBrowser = output<void>();

  protected readonly format = inject(Formatter);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  /** The item a removal is being confirmed for, and whether its backups go too. */
  protected readonly removing = signal<{ row: ItemRow; deleteArchives: boolean } | null>(null);
  protected readonly pickerOpen = signal(false);

  protected label(row: ItemRow): ItemLabel {
    return this.labels().get(row.item.id) ?? { text: '', ltr: false };
  }

  protected toggleFolder(row: ItemRow, field: string, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    const current = row.item.excludedFields;
    this.setFolders.emit({
      itemId: row.item.id,
      excludedFields: on ? current.filter((f) => f !== field) : [...current, field],
    });
  }

  /** At least one folder of a service stays on. */
  protected lastFolder(row: ItemRow, field: string): boolean {
    const off = row.item.excludedFields;
    return !off.includes(field) && off.length === row.folders.length - 1;
  }

  protected confirmRemove(row: ItemRow, deleteArchives = false): void {
    this.removing.set({ row, deleteArchives });
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
