import {
  Component,
  computed,
  inject,
  Injector,
  input,
  type OnInit,
  signal,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import {
  type FieldTree,
  form,
  FormField,
  FormRoot,
  validateStandardSchema,
} from '@angular/forms/signals';
import {
  BACKUP_FREQUENCIES,
  type BackupDestination,
  type BackupPlan,
  type BackupSettingsForm,
  backupSettingsFormSchema,
} from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideKeyRound } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { HlmSelectImports } from '@ui/select';
import { Translator } from '../../../core/i18n/translator';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { BackupsPageStore } from '../backups-page/backups-page-store';
import { PassphraseDialog } from '../passphrase-dialog/passphrase-dialog';

/**
 * The plan's settings: when backups run, how many are kept, the disk (another disk starts a new
 * set of backups) — and "Show the passphrase again". Submits through the page store.
 */
@Component({
  selector: 'laris-backup-settings',
  imports: [
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmButton,
    HlmCardImports,
    HlmFieldImports,
    HlmInput,
    HlmSelectImports,
    NgIcon,
    PassphraseDialog,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideKeyRound })],
  templateUrl: './backup-settings.html',
})
export class BackupSettings implements OnInit {
  readonly plan = input.required<BackupPlan>();
  readonly destinations = input<BackupDestination[] | null>(null);

  private readonly store = inject(BackupsPageStore);
  private readonly injector = inject(Injector);
  private readonly passphraseDialog = viewChild.required(PassphraseDialog);
  protected readonly frequencies = BACKUP_FREQUENCIES;
  private readonly translator = inject(Translator);
  /** What the select shows for the chosen frequency. */
  protected readonly frequencyLabel = (frequency: string) =>
    this.translator.t(`backups.schedule.${frequency}`);
  protected readonly keepParts = ['daily', 'weekly', 'monthly'] as const;

  protected model!: WritableSignal<BackupSettingsForm>;
  protected form!: FieldTree<BackupSettingsForm>;

  /** The disks to choose from: the supported mounted ones, and the current one even if it's gone. */
  protected readonly disks = computed(() => {
    const current = this.plan().destination;
    const mounted = (this.destinations() ?? []).filter((d) => d.supported).map((d) => d.mountPoint);
    return mounted.includes(current) ? mounted : [current, ...mounted];
  });
  protected readonly diskChanged = computed(
    () => this.model?.().destination !== this.plan().destination,
  );

  ngOnInit(): void {
    const plan = this.plan();
    this.model = signal<BackupSettingsForm>({
      destination: plan.destination,
      schedule: { ...plan.schedule },
      retention: { ...plan.retention },
    });
    this.form = form(this.model, (path) => validateStandardSchema(path, backupSettingsFormSchema), {
      injector: this.injector,
      submission: {
        action: async (tree) => {
          const { destination, schedule, retention } = tree().value();
          try {
            await this.store.updatePlan({
              schedule,
              retention,
              ...(destination !== this.plan().destination ? { destination } : {}),
            });
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          return undefined;
        },
      },
    });
  }

  protected keep(part: (typeof this.keepParts)[number]) {
    return this.form.retention[part];
  }

  protected showPassphrase(): void {
    this.passphraseDialog().open();
  }
}
