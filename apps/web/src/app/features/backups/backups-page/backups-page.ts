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
import { BackupsPageStore } from './backups-page-store';

/** A finished restore stays shown this long (one with folders set aside, until they're deleted). */
const RESTORE_SHOWN_MS = 24 * 60 * 60_000;

/**
 * Backups: set up once (disk, schedule, what), then where they stand — the running backup,
 * what's backed up with its actions, restores, the history and the settings. UI only: the data
 * and actions live in its page store; it names the items and chooses what to show.
 */
@Component({
  selector: 'app-backups-page',
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
  protected readonly store = inject(BackupsPageStore);
  private readonly translator = inject(Translator);
  private readonly restoreDialog = viewChild(RestoreDialog);

  /** What each item is called (removed ones too, for the history). */
  protected readonly labels = computed(() => {
    const labels = new Map<string, ItemLabel>();
    const { active, removed } = this.store.rows();
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
    const restore = this.store.status()?.restore;
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
    const row = this.store
      .rows()
      .active.concat(this.store.rows().removed)
      .find((r) => r.item.id === restore?.itemId);
    const catalogId = row?.item.catalogId;
    const entry = (this.store.catalog() ?? []).find((e) => e.id === catalogId);
    return entry?.backupRestoreNote ? `catalog.${entry.id}.backup.restoreNote` : null;
  });

  protected openRestore(row: ItemRow): void {
    this.restoreDialog()?.open(row);
    void this.store.loadArchives(row.item.id);
  }
}
