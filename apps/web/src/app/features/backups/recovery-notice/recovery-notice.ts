import { Component, computed, inject, input, output } from '@angular/core';
import type { BackupRecovery } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { CopyCommand } from '../../../shared/copy-command/copy-command';
import { Formatter } from '../../../shared/format/formatter';

/**
 * After Ilexarium was restored from the backup disk (or a try failed): from which backup, the
 * accounts its apps and folders belong to compared with this machine's (restores keep owners by
 * number — a missing one is made first), what to do next. UI only: `dismiss` hides it for good.
 */
@Component({
  selector: 'ilex-recovery-notice',
  imports: [CopyCommand, HlmAlertImports, HlmButton, TranslatePipe],
  templateUrl: './recovery-notice.html',
})
export class RecoveryNotice {
  readonly recovery = input.required<BackupRecovery>();
  readonly pending = input(false);
  readonly dismiss = output<void>();

  private readonly formatter = inject(Formatter);
  protected readonly time = computed(() => this.formatter.dateTime(this.recovery().archiveTime));
  protected readonly accounts = computed(() =>
    (this.recovery().accounts ?? []).map((account) => ({
      ...account,
      state: account.here === null ? 'missing' : account.here === account.name ? 'there' : 'other',
      command: `sudo useradd --create-home --uid ${account.uid} ${account.name}`,
    })),
  );
}
