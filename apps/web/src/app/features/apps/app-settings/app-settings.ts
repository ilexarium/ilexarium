import { Component, computed, input, output } from '@angular/core';
import type { AppField } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmLabel } from '@ui/label';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTextarea } from '@ui/textarea';
import { AppFields } from '../app-fields/app-fields';
import type { FieldChange } from '../apps.model';

/**
 * An app's settings as two sections: the template's form, and its two files (folded when there's
 * a form; an app without a template, or one no longer in the catalog, has only the files).
 */
@Component({
  selector: 'laris-app-settings',
  imports: [AppFields, HlmLabel, HlmSkeleton, HlmTextarea, TranslatePipe],
  host: { class: 'grid gap-6' },
  templateUrl: './app-settings.html',
})
export class AppSettings {
  /** The template the form comes from; null: none. */
  readonly templateId = input<string | null>(null);
  /** Null while the template's form loads. */
  readonly fields = input<AppField[] | null>([]);
  readonly values = input.required<ReadonlyMap<string, string>>();
  readonly compose = input.required<string>();
  readonly env = input.required<string>();
  readonly disabled = input(false);
  readonly fieldChanged = output<FieldChange>();
  readonly composeChanged = output<string>();
  readonly envChanged = output<string>();

  protected readonly hasForm = computed(() => {
    const fields = this.fields();
    return this.templateId() !== null && (fields === null || fields.length > 0);
  });

  protected text(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }
}
