import { Component, input } from '@angular/core';
import { type FieldTree, FormField } from '@angular/forms/signals';
import type { BackupRetention } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { RETENTION_PARTS } from '../backups.constants';

/** How many backups are kept: daily, weekly, monthly, as the parent's own flex items. */
@Component({
  selector: 'ilex-retention-fields',
  imports: [FieldErrors, FormField, HlmFieldImports, HlmInput, TranslatePipe],
  host: { class: 'contents' },
  templateUrl: './retention-fields.html',
})
export class RetentionFields {
  readonly retention = input.required<FieldTree<BackupRetention>>();
  /** Makes the fields' ids unique on the page. */
  readonly idPrefix = input.required<string>();

  protected readonly parts = RETENTION_PARTS;
}
