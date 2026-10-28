import { Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { type BackupArchive, isBackupFolder } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmSkeleton } from '@ui/skeleton';
import { Formatter } from '../../../shared/format/formatter';
import type { ItemLabel, ItemRow, RestoreChoice } from '../backups.model';

/**
 * Restoring one item: which backup (newest first), and where — back where it was (an app is
 * stopped, the current folders set aside as the way back, then it's started again) or into a
 * folder of the person's choice (missing or empty), with the full paths below it. The platform
 * only goes to a folder. The confirm button is the confirmation. UI only: the page
 * opens it (`open`) and loads the archives; the choice goes out through `restore`.
 */
@Component({
  selector: 'laris-restore-dialog',
  imports: [HlmAlertDialogImports, HlmSkeleton, TranslatePipe],
  templateUrl: './restore-dialog.html',
})
export class RestoreDialog {
  /** The archives of the item it's open for; null while loading. */
  readonly archives = input<BackupArchive[] | null>(null);
  readonly labels = input<Map<string, ItemLabel>>(new Map());

  readonly restore = output<RestoreChoice>();

  protected readonly formatter = inject(Formatter);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  protected readonly row = signal<ItemRow | null>(null);
  protected readonly archive = signal<string | null>(null);
  protected readonly target = signal<'original' | 'folder'>('folder');
  protected readonly folder = signal('');

  protected readonly label = computed(() => {
    const row = this.row();
    return (row && this.labels().get(row.item.id)) || { text: '', ltr: false };
  });
  protected readonly inPlaceAllowed = computed(() => this.row()?.item.kind !== 'platform');
  protected readonly folderValid = computed(() => isBackupFolder(this.folder().trim()));
  /** The newest backup, until one is chosen. */
  protected readonly chosen = computed(() => this.archive() ?? this.archives()?.[0]?.name ?? null);

  open(row: ItemRow): void {
    this.row.set(row);
    this.archive.set(null);
    this.target.set(row.item.kind === 'platform' ? 'folder' : 'original');
    this.folder.set('');
    this.dialog().open();
  }

  protected choose(event: Event): void {
    this.archive.set((event.target as HTMLInputElement).value);
  }

  protected setTarget(target: 'original' | 'folder'): void {
    this.target.set(target);
  }

  protected setFolder(event: Event): void {
    this.folder.set((event.target as HTMLInputElement).value);
  }

  protected confirmed(): void {
    const row = this.row();
    const archive = this.chosen();
    this.dialog().close();
    if (!row || !archive) return;
    const target = this.target() === 'original' ? null : this.folder().trim();
    this.restore.emit({ itemId: row.item.id, archive, target });
  }
}
