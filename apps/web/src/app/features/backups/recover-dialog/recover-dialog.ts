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
  type BackupRecoveryArchive,
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
 * Restoring Ilexarium from a backup disk: the mounted disks holding backups (or the way to the
 * Disks page), the passphrase, then which backup (the newest unless another is chosen) — and the wait while it
 * restarts. UI only: the page store does each step (`check`, `recover`); the passphrase lives
 * here until it's sent, and goes when the dialog closes.
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
  /** The backups' folders on the mounted disks; null while the disks load. */
  readonly repositories = input<string[] | null>(null);
  /** The backups of Ilexarium (oldest first), once the passphrase opened their repository. */
  readonly backups = input<{ repository: string; archives: BackupRecoveryArchive[] } | null>(null);
  readonly step = input<RecoveryStep>('idle');
  readonly error = input<string | null>(null);

  /** "Look again": the disks read again (one mounted meanwhile). */
  readonly refresh = output<void>();
  readonly check = output<{ repository: string; passphrase: string }>();
  readonly recover = output<BackupRecoveryRequest>();
  readonly closed = output<void>();

  /** Follows `open`; while it restores, it stays open. */
  protected readonly shown = linkedSignal(() => this.open());
  private readonly formatter = inject(Formatter);
  protected readonly showPassphrase = signal(false);
  /** The repository chosen: kept while the list still has it (the check's answer lists them again). */
  protected readonly chosen = linkedSignal<string[], string | null>({
    source: () => this.repositories() ?? [],
    computation: (list, previous) =>
      previous?.value && list.includes(previous.value) ? previous.value : (list[0] ?? null),
  });

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

  /** Newest first, each with its date in words. */
  protected readonly archives = computed(() =>
    [...(this.backups()?.archives ?? [])]
      .reverse()
      .map((archive) => ({ name: archive.name, time: this.formatter.dateTime(archive.time) })),
  );
  /** The backup to restore: the newest until another is chosen. */
  protected readonly chosenArchive = linkedSignal(() => this.archives()[0]?.name ?? null);
  protected readonly busy = computed(() =>
    ['checking', 'starting', 'waiting'].includes(this.step()),
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.form().reset({ passphrase: '' });
        this.showPassphrase.set(false);
      });
    });
  }

  protected choose(repository: string): void {
    this.chosen.set(repository);
  }

  protected restore(): void {
    const backups = this.backups();
    const archive = this.chosenArchive();
    if (!backups || !archive) return;
    this.recover.emit({
      repository: backups.repository,
      passphrase: this.form.passphrase().value(),
      archive,
    });
  }

  /** While it starts or restores the dialog can't be closed: the wait stays on screen. */
  protected readonly restoring = computed(() => ['starting', 'waiting'].includes(this.step()));

  protected close(): void {
    if (this.restoring()) return;
    this.form().reset({ passphrase: '' });
    this.shown.set(false);
    this.closed.emit();
  }
}
