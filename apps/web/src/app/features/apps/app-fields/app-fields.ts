import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import type { AppField } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmInput } from '@ui/input';
import { HlmLabel } from '@ui/label';
import type { FieldChange } from '../apps.model';

/**
 * A template's fields as a form, their texts the template's. A kind is a hint (how a field is
 * shown); plain text always works — Ilexarium never checks a value against it.
 */
@Component({
  selector: 'ilex-app-fields',
  imports: [HlmInput, HlmLabel, NgTemplateOutlet, TranslatePipe],
  host: { class: 'grid gap-5' },
  templateUrl: './app-fields.html',
})
export class AppFields {
  readonly fields = input.required<AppField[]>();
  /** The values now (from the `.env` being edited), by key. */
  readonly values = input.required<ReadonlyMap<string, string>>();
  /** The template the fields' texts come from. */
  readonly templateId = input.required<string>();
  readonly disabled = input(false);
  readonly changed = output<FieldChange>();

  protected readonly main = computed(() =>
    this.fields().filter((f) => !f.advanced && f.kind !== 'generated'),
  );
  protected readonly advanced = computed(() =>
    this.fields().filter((f) => f.advanced || f.kind === 'generated'),
  );

  protected value(field: AppField): string {
    return this.values().get(field.key) ?? field.value;
  }

  protected text(field: AppField, part: 'label' | 'help'): string {
    return `catalog.${this.templateId()}.fields.${field.key}.${part}`;
  }

  protected inputType(field: AppField): string {
    return field.kind === 'secret' || field.kind === 'generated' ? 'password' : 'text';
  }

  protected edit(field: AppField, event: Event): void {
    this.changed.emit({ key: field.key, value: (event.target as HTMLInputElement).value });
  }
}
