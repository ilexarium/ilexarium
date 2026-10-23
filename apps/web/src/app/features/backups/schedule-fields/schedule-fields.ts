import { Component, inject, input } from '@angular/core';
import { type FieldTree, FormField } from '@angular/forms/signals';
import { BACKUP_FREQUENCIES, type BackupSchedule } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { HlmSelectImports } from '@ui/select';
import { Translator } from '../../../core/i18n/translator';
import { FieldErrors } from '../../../shared/forms/field-errors';

/** When backups run: the frequency and the time, as the parent's own flex items. */
@Component({
  selector: 'laris-schedule-fields',
  imports: [FieldErrors, FormField, HlmFieldImports, HlmInput, HlmSelectImports, TranslatePipe],
  host: { class: 'contents' },
  templateUrl: './schedule-fields.html',
})
export class ScheduleFields {
  readonly schedule = input.required<FieldTree<BackupSchedule>>();
  /** Makes the fields' ids unique on the page. */
  readonly idPrefix = input.required<string>();

  private readonly translator = inject(Translator);
  protected readonly frequencies = BACKUP_FREQUENCIES;
  protected readonly frequencyLabel = (frequency: string) =>
    this.translator.t(`backups.schedule.${frequency}`);
}
