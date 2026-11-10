import { Component, input, output } from '@angular/core';
import type { BackupRestore } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import type { ItemLabel } from '../backups.model';

/**
 * The latest restore (its own unit): its phase and output while it runs, then where it went — or,
 * back where it was, the folders set aside (the previous version, kept until "Delete previous
 * version") and the template's note
 * (e.g. "restore the database in Immich"); an app that was running is started as it was, and
 * `apply` offers its restored files (compose file, versions). UI only: the clicks go out.
 */
@Component({
  selector: 'ilex-restore-status',
  imports: [HlmAlertImports, HlmButton, HlmCardImports, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideLoaderCircle })],
  templateUrl: './restore-status.html',
})
export class RestoreStatus {
  readonly restore = input.required<BackupRestore>();
  readonly label = input<ItemLabel>({ text: '', ltr: false });
  /** A translation key: what to do after restoring this app. */
  readonly note = input<string | null>(null);
  readonly pending = input(false);

  readonly discard = output<void>();
  readonly apply = output<void>();
}
