import { Component, computed, inject, input, linkedSignal, untracked } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
  type BackupDestination,
  type BackupPlan,
  type BackupSettingsForm,
  backupSettingsFormSchema,
} from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmFieldImports } from '@ui/field';
import { HlmSelectImports } from '@ui/select';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { SaveBar } from '../../../shared/save-bar/save-bar';
import { BackupsPageStore } from '../backups-page/backups-page-store';
import { RetentionFields } from '../retention-fields/retention-fields';
import { ScheduleFields } from '../schedule-fields/schedule-fields';

/**
 * The plan's settings: when backups run, how many are kept, the disk (another disk starts a new
 * set of backups). A save bar while something changed; submits through the page store.
 */
@Component({
  selector: 'ilex-backup-settings',
  imports: [
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmFieldImports,
    HlmSelectImports,
    RetentionFields,
    SaveBar,
    ScheduleFields,
    TranslatePipe,
  ],
  templateUrl: './backup-settings.html',
})
export class BackupSettings {
  readonly plan = input.required<BackupPlan>();
  readonly destinations = input<BackupDestination[] | null>(null);

  private readonly backupsPageStore = inject(BackupsPageStore);

  /**
   * The saved plan, until it's saved again (here or elsewhere): the page reloads the plan after
   * every run, and that mustn't throw away what's being typed.
   */
  // A computed, not a plain function: linkedSignal would recompute for every new plan object.
  private readonly savedAt = computed(() => this.plan().updatedAt);
  private readonly saved = computed((): BackupSettingsForm => {
    this.savedAt();
    const plan = untracked(this.plan);
    return {
      destination: plan.destination,
      schedule: { ...plan.schedule },
      retention: { ...plan.retention },
    };
  });
  private readonly model = linkedSignal(() => structuredClone(this.saved()));
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
  protected readonly changed = computed(
    () => JSON.stringify(this.model()) !== JSON.stringify(this.saved()),
  );

  protected discard(): void {
    this.model.set(structuredClone(this.saved()));
  }
}
