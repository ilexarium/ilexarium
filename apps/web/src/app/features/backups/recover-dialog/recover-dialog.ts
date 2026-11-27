import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import {
  type BackupRecoveryCheckResponse,
  type BackupRecoveryPassphraseForm,
  type BackupRecoveryRequest,
  backupRecoveryPassphraseFormSchema,
} from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmDialogImports } from '@ui/dialog';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { Formatter } from '../../../shared/format/formatter';
import type { RecoveryStep } from '../backups-page/store/backups-page-store.model';

/**
 * Restoring Ilexarium from a backup disk: the backups found on mounted disks (or the way to the
 * Disks page), the passphrase, then the newest backup's date to confirm — and the wait while it
 * restarts. UI only: the page store does each step (`find`, `check`, `recover`); the passphrase
 * lives here until it's sent, and goes when the dialog closes.
 */
@Component({
  selector: 'ilex-recover-dialog',
  imports: [
    FieldErrors,
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmDialogImports,
    HlmFieldImports,
    HlmInput,
    PasswordToggle,
    RouterLink,
    TranslatePipe,
  ],
  templateUrl: './recover-dialog.html',
})
export class RecoverDialog {
  readonly open = input(false);
  readonly found = input<BackupRecoveryCheckResponse | null>(null);
  readonly step = input<RecoveryStep>('idle');
  readonly error = input<string | null>(null);

  readonly find = output<void>();
  readonly check = output<{ repository: string; passphrase: string }>();
  readonly recover = output<BackupRecoveryRequest>();
  readonly closed = output<void>();

  /** Follows `open`; while it restores, it stays open. */
  protected readonly shown = linkedSignal(() => this.open());
  private readonly formatter = inject(Formatter);
  protected readonly showPassphrase = signal(false);
  protected readonly chosen = linkedSignal(() => this.found()?.repositories[0] ?? null);

  private readonly model = signal<BackupRecoveryPassphraseForm>({ passphrase: '' });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, backupRecoveryPassphraseFormSchema),
    {
      submission: {
        action: async (field) => {
          const repository = this.chosen();
          if (repository) this.check.emit({ repository, passphrase: field().value().passphrase });
          return undefined;
        },
      },
    },
  );

  protected readonly newest = computed(() => this.found()?.archives?.[0] ?? null);
  protected readonly newestTime = computed(() => {
    const newest = this.newest();
    return newest ? this.formatter.dateTime(newest.time) : '';
  });
  protected readonly busy = computed(() =>
    ['finding', 'checking', 'starting', 'waiting'].includes(this.step()),
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.form().reset({ passphrase: '' });
        this.showPassphrase.set(false);
        this.find.emit();
      });
    });
  }

  protected choose(repository: string): void {
    this.chosen.set(repository);
  }

  protected restore(): void {
    const repository = this.chosen();
    const newest = this.newest();
    if (!repository || !newest) return;
    this.recover.emit({
      repository,
      passphrase: this.form.passphrase().value(),
      archive: newest.name,
    });
  }

  protected close(): void {
    if (this.step() === 'waiting' || this.step() === 'starting') return;
    this.form().reset({ passphrase: '' });
    this.shown.set(false);
  }
}
