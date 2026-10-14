import { Injectable } from '@nestjs/common';
import type { BackupsStatus } from '@homelab/shared';
import { OperationSlot } from '../jobs/operation-slot.js';
import { RealtimeSubscriptions } from '../realtime/realtime-subscriptions.js';
import type { TopicSource } from '../realtime/realtime.model.js';
import { BackupManager } from './backup-manager.js';
import { BackupProgressFollower } from './backup-progress.js';
import { BackupRestores } from './backup-restores.js';
import { BackupResults } from './backup-results.js';

/** Changes come in bursts (progress lines, restore output): at most one update this often. */
export const BACKUPS_PUBLISH_MS = 500;
/** Also now and then without a change: "last backed up" ages, the disk fills. */
const REFRESH_MS = 60_000;

/**
 * The `backups` topic: the plan's status and warnings, the running run's live progress (scheduled
 * or manual, from the wrapper's progress file), the last results, the latest restore.
 */
@Injectable()
export class BackupsTopic implements TopicSource<'backups'> {
  readonly topic = 'backups';
  private unsubscribers: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private refresh: NodeJS.Timeout | null = null;

  constructor(
    private readonly backups: BackupManager,
    private readonly progress: BackupProgressFollower,
    private readonly results: BackupResults,
    private readonly restores: BackupRestores,
    private readonly slot: OperationSlot,
    subscriptions: RealtimeSubscriptions,
  ) {
    subscriptions.registerSource(this);
  }

  snapshot(): Promise<BackupsStatus> {
    return this.backups.status();
  }

  start(publish: (update: BackupsStatus) => void): void {
    const changed = () => {
      this.timer ??= setTimeout(() => {
        this.timer = null;
        void this.snapshot().then(publish, () => undefined);
      }, BACKUPS_PUBLISH_MS);
    };
    this.unsubscribers = [
      this.backups.onChange(changed),
      this.progress.onChange(changed),
      this.results.onChange(changed),
      this.restores.onChange(changed),
      this.slot.onChange(changed),
    ];
    this.refresh = setInterval(changed, REFRESH_MS);
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.refresh) clearInterval(this.refresh);
    this.timer = null;
    this.refresh = null;
  }
}
