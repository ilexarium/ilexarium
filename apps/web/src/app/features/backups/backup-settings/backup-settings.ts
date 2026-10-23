import {
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  untracked,
  viewChild,
} from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
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
import { HlmSelectImports } from '@ui/select';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { BackupsPageStore } from '../backups-page/backups-page-store';
import { PassphraseDialog } from '../passphrase-dialog/passphrase-dialog';
import { RetentionFields } from '../retention-fields/retention-fields';
import { ScheduleFields } from '../schedule-fields/schedule-fields';

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
    HlmSelectImports,
    NgIcon,
    PassphraseDialog,
    RetentionFields,
    ScheduleFields,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideKeyRound })],
  templateUrl: './backup-settings.html',
})
export class BackupSettings {
  readonly plan = input.required<BackupPlan>();
  readonly destinations = input<BackupDestination[] | null>(null);

  private readonly backupsPageStore = inject(BackupsPageStore);
  private readonly passphraseDialog = viewChild.required(PassphraseDialog);

  /**
   * The saved plan, until it's saved again (here or elsewhere): the page reloads the plan after
   * every run, and that mustn't throw away what's being typed.
   */
  // A computed, not a plain function: linkedSignal would recompute for every new plan object.
  private readonly savedAt = computed(() => this.plan().updatedAt);
  private readonly model = linkedSignal<string, BackupSettingsForm>({
    source: this.savedAt,
    computation: () => {
      const plan = untracked(this.plan);
      return {
        destination: plan.destination,
        schedule: { ...plan.schedule },
        retention: { ...plan.retention },
      };
    },
  });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, backupSettingsFormSchema),
    {
      submission: {
        action: async (tree) => {
          const { destination, schedule, retention } = tree().value();
          try {
            await this.backupsPageStore.updatePlan({
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
    },
  );

  /** The disks to choose from: the supported mounted ones, and the current one even if it's gone. */
  protected readonly disks = computed(() => {
    const current = this.plan().destination;
    const mounted = (this.destinations() ?? []).filter((d) => d.supported).map((d) => d.mountPoint);
    return mounted.includes(current) ? mounted : [current, ...mounted];
  });
  protected readonly diskChanged = computed(
    () => this.model().destination !== this.plan().destination,
  );

  protected showPassphrase(): void {
    this.passphraseDialog().open();
  }
}
