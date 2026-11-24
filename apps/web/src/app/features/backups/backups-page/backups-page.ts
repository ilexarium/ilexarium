import { Component, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTabsImports } from '@ui/tabs';
import { AppsStore } from '../../../core/apps/apps-store';
import { Translator } from '../../../core/i18n/translator';
import { BackupHeader } from '../backup-header/backup-header';
import { BackupHistory } from '../backup-history/backup-history';
import { BackupItems } from '../backup-items/backup-items';
import { BackupSettings } from '../backup-settings/backup-settings';
import { BackupSetup } from '../backup-setup/backup-setup';
import { BACKUPS_TABS, RESTORE_SHOWN_MS } from '../backups.constants';
import type { BackupsTab, ItemLabel, ItemRow } from '../backups.model';
import { ItemSheet } from '../item-sheet/item-sheet';
import { PassphraseCard } from '../passphrase-card/passphrase-card';
import { RemoveItemDialog } from '../remove-item-dialog/remove-item-dialog';
import { RestoreDialog } from '../restore-dialog/restore-dialog';
import { RestoreStatus } from '../restore-status/restore-status';
import { RunProgress } from '../run-progress/run-progress';
import { BackupsPageStore } from './store/backups-page-store';

/**
 * Backups: set up once (disk, what, when), then where they stand — the header (headline, disk,
 * warnings), a running backup or restore, and the tabs What's backed up (cards, each with its
 * side sheet) | History | Settings. UI only: the data and actions live in its page store; it
 * names the items, keeps the tab in the URL and chooses what to show.
 */
@Component({
  selector: 'ilex-backups-page',
  imports: [
    BackupHeader,
    BackupHistory,
    BackupItems,
    BackupSettings,
    BackupSetup,
    HlmSkeleton,
    HlmTabsImports,
    ItemSheet,
    PassphraseCard,
    RemoveItemDialog,
    RestoreDialog,
    RestoreStatus,
    RunProgress,
    TranslatePipe,
  ],
  providers: [BackupsPageStore],
  templateUrl: './backups-page.html',
})
export class BackupsPage {
  protected readonly backupsPageStore = inject(BackupsPageStore);
  private readonly translator = inject(Translator);
  private readonly appsStore = inject(AppsStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly restoreDialog = viewChild(RestoreDialog);
  private readonly removeDialog = viewChild(RemoveItemDialog);

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
            : { text: row.name ?? '', ltr: true },
      );
    }
    return labels;
  });

  /** The latest restore, while it's worth showing. */
  protected readonly restore = computed(() => {
    const restore = this.backupsPageStore.status()?.restore;
    if (!restore) return null;
    const waiting = restore.setAside.length > 0 && !restore.setAsideDeleted;
    const finished = restore.finishedAt ? Date.parse(restore.finishedAt) : Date.now();
    return restore.status === 'running' || waiting || Date.now() - finished < RESTORE_SHOWN_MS
      ? restore
      : null;
  });

  /** The app's template's note after a restore (e.g. "restore the database in Immich"). */
  protected readonly restoreNote = computed(() => {
    const restore = this.restore();
    const row = this.backupsPageStore
      .rows()
      .active.concat(this.backupsPageStore.rows().removed)
      .find((r) => r.item.id === restore?.itemId);
    const app = this.backupsPageStore.apps().find((a) => a.name === row?.item.project);
    const template = app?.template
      ? this.appsStore.templatesById().get(app.template.id)
      : undefined;
    return template?.backupRestoreNote ? `catalog.${template.id}.backup.restoreNote` : null;
  });

  protected readonly sheetLabel = computed(() => {
    const row = this.backupsPageStore.sheetRow();
    return (row && this.labels().get(row.item.id)) || { text: '', ltr: false };
  });

  private readonly query = toSignal(this.route.queryParamMap, { requireSync: true });
  private readonly tab = computed((): BackupsTab => {
    const tab = this.query().get('tab');
    return BACKUPS_TABS.find((t) => t === tab) ?? 'items';
  });

  constructor() {
    effect(() => {
      this.backupsPageStore.setTab(this.tab());
    });
    // Opened from an app's page (`?restore=<item>`): its restore dialog, once.
    let opened = false;
    effect(() => {
      const itemId = this.query().get('restore');
      const row = this.backupsPageStore.rows().active.find((r) => r.item.id === itemId);
      if (!opened && row) {
        opened = true;
        untracked(() => this.openRestore(row));
      }
    });
  }

  protected chooseTab(tab: string): void {
    if (tab === this.tab()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'items' ? null : tab, restore: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** The sheet's actions; a dialog closes the sheet first (one overlay at a time). */
  protected fromSheet(action: 'runNow' | 'restore' | 'remove'): void {
    const row = this.backupsPageStore.sheetRow();
    if (!row) return;
    if (action === 'runNow') this.backupsPageStore.runItemNow(row.item.id);
    else if (action === 'restore') this.openRestore(row);
    else this.askRemove(row);
  }

  protected openRestore(row: ItemRow): void {
    this.backupsPageStore.closeSheet();
    this.restoreDialog()?.open(row);
    this.backupsPageStore.loadArchives(row.item.id);
  }

  protected askRemove(row: ItemRow): void {
    this.backupsPageStore.closeSheet();
    this.removeDialog()?.open(row);
  }
}
