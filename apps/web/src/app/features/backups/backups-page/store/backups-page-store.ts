import { computed, effect, inject, untracked } from '@angular/core';
import { signalStore, withHooks, withMethods } from '@ngrx/signals';
import { BackupsStore } from '../../../../core/backups/backups-store';
import { MonitoringStore } from '../../../../core/monitoring/monitoring-store';
import { withBackupHistory } from './with-backup-history';
import { withBackupItems } from './with-backup-items';
import { withBackupPlan } from './with-backup-plan';
import { withBackupRecovery } from './with-backup-recovery';
import { withBackupRestores } from './with-backup-restores';
import { withBackupsCore } from './with-backups-core';
import { withFolderPicker } from './with-folder-picker';

/**
 * The Backups page's data, provided by the page and gone with it: the plan and its items, the
 * apps that aren't in it, the disks, run history, restores, the folder picker, and every action
 * with its toast — changes done as the person, through their sudo; each area a feature of its own.
 * Live parts (the running run, the latest restore, warnings) come from the global `BackupsStore`;
 * when they change, the page reloads what they affect.
 */
export const BackupsPageStore = signalStore(
  withBackupsCore(),
  withBackupPlan(),
  withBackupHistory(),
  withFolderPicker(),
  withBackupItems(),
  withBackupRestores(),
  withBackupRecovery(),
  withMethods((store) => ({
    load(): void {
      store._loadDestinations();
      store.reload();
      store.loadRecovery();
    },
  })),
  withHooks(
    (store, monitoringStore = inject(MonitoringStore), backupsStore = inject(BackupsStore)) => {
      let stop: (() => void) | null = null;
      return {
        onInit() {
          stop = monitoringStore.watch(['containers']);
          store.load();
          // What the topic says changed (a run ended, a restore moved on, setup elsewhere): reload.
          // The key is a string, so the effect runs only when it really changes.
          const changes = computed(() => {
            const status = backupsStore.status();
            return status
              ? [
                  status.configured,
                  status.lastRun?.id,
                  status.lastRun?.status,
                  status.restore?.id,
                  status.restore?.status,
                  status.running?.runId,
                ].join('|')
              : null;
          });
          let seen: string | null = null;
          effect(() => {
            const key = changes();
            if (key === null || key === seen) return;
            if (seen !== null) untracked(() => store.reload());
            seen = key;
          });
        },
        onDestroy() {
          stop?.();
        },
      };
    },
  ),
);
