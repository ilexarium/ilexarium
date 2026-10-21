import { Component, computed, input, output } from '@angular/core';
import type { BackupRestore, JobPhase } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { JobProgress } from '../../../shared/job-progress/job-progress';
import type { ItemLabel } from '../backups.model';

/**
 * The latest restore: its progress while it runs, then where it went — or, in place, the folders
 * set aside (the previous version, kept until "Delete previous version") and the service's note
 * (e.g. "restore the database in Immich"). UI only: `discard` reports the click.
 */
@Component({
  selector: 'laris-restore-status',
  imports: [HlmAlertImports, HlmButton, HlmCardImports, JobProgress, TranslatePipe],
  templateUrl: './restore-status.html',
})
export class RestoreStatus {
  readonly restore = input.required<BackupRestore>();
  readonly label = input<ItemLabel>({ text: '', ltr: false });
  /** A translation key: what to do after restoring this service. */
  readonly note = input<string | null>(null);
  readonly pending = input(false);

  readonly discard = output<void>();

  /** To a new folder, nothing is stopped or started: only restoring. */
  protected readonly phases = computed((): JobPhase[] | null =>
    this.restore().target === 'newFolder' ? ['restoring', 'done'] : null,
  );
}
