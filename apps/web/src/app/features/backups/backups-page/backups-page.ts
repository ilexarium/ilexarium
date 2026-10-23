import { Component, computed, inject, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmSkeleton } from '@ui/skeleton';
import { Translator } from '../../../core/i18n/translator';
import { BackupHistory } from '../backup-history/backup-history';
import { BackupItems } from '../backup-items/backup-items';
import { BackupOverview } from '../backup-overview/backup-overview';
import { BackupSettings } from '../backup-settings/backup-settings';
import { BackupSetup } from '../backup-setup/backup-setup';
import type { ItemLabel, ItemRow } from '../backups.model';
import { PassphraseCard } from '../passphrase-card/passphrase-card';
import { RestoreDialog } from '../restore-dialog/restore-dialog';
import { RestoreStatus } from '../restore-status/restore-status';
import { RESTORE_SHOWN_MS } from '../backups.constants';
import { BackupsPageStore } from './backups-page-store';

/**
 * Backups: set up once (disk, schedule, what), then where they stand — the running backup,
 * what's backed up with its actions, restores, the history and the settings. UI only: the data
 * and actions live in its page store; it names the items and chooses what to show.
 */
@Component({
  selector: 'laris-backups-page',
  imports: [
    BackupHistory,
    BackupItems,
    BackupOverview,
    BackupSettings,
    BackupSetup,
    HlmSkeleton,
    PassphraseCard,
    RestoreDialog,
    RestoreStatus,
    TranslatePipe,
  ],
  providers: [BackupsPageStore],
  templateUrl: './backups-page.html',
})
export class BackupsPage {
  protected readonly backupsPageStore = inject(BackupsPageStore);
  private readonly translator = inject(Translator);
  private readonly restoreDialog = viewChild(RestoreDialog);

  /** What each item is called (removed ones too, for the history). */
  protected readonly labels = computed(() => {
    const labels = new Map<string, ItemLabel>();
    const { active, removed } = this.backupsPageStore.rows();
    for (const row of [...active, ...removed]) {
      const { item } = row;
      labels.set(
        item.id,
        item.kind === 'platform'
          ? { text: this.translator.t('backups.items.platformShort'), ltr: false }
          : item.kind === 'folder'
            ? { text: item.path ?? '', ltr: true }
            : { text: row.name ?? '', ltr: false },
      );
    }
    return labels;
  });

  /** The latest restore, while it's worth showing. */
  protected readonly restore = computed(() => {
    const restore = this.backupsPageStore.status()?.restore;
    if (!restore) return null;
    const waiting = restore.setAside.length > 0 && !restore.setAsideDeleted;
    const finished = restore.job.finishedAt ? Date.parse(restore.job.finishedAt) : Date.now();
    return restore.job.status === 'running' || waiting || Date.now() - finished < RESTORE_SHOWN_MS
      ? restore
      : null;
  });

  /** The service's note after a restore (e.g. "restore the database in Immich"). */
  protected readonly restoreNote = computed(() => {
    const restore = this.restore();
    const row = this.backupsPageStore
      .rows()
      .active.concat(this.backupsPageStore.rows().removed)
      .find((r) => r.item.id === restore?.itemId);
    const catalogId = row?.item.catalogId;
    const entry = catalogId ? this.backupsPageStore.catalogById().get(catalogId) : undefined;
    return entry?.backupRestoreNote ? `catalog.${entry.id}.backup.restoreNote` : null;
  });

  protected openRestore(row: ItemRow): void {
    this.restoreDialog()?.open(row);
    void this.backupsPageStore.loadArchives(row.item.id);
  }
}
