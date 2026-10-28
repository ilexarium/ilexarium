import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import type { AppField, FieldKind } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideList, lucideLoaderCircle } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmLabel } from '@ui/label';
import { SHOWN_KINDS } from '../apps.constants';
import type { FieldChange, VersionList } from '../apps.model';

/**
 * The variables of an app's Compose file as a form, a template's and a pasted file's alike. A
 * kind is a hint (how a field is shown); plain text always works — Laris never checks a value
 * against it. Version fields can list the image's versions.
 */
@Component({
  selector: 'laris-app-fields',
  imports: [HlmButton, HlmInput, HlmLabel, NgIcon, NgTemplateOutlet, TranslatePipe],
  providers: [provideIcons({ lucideList, lucideLoaderCircle })],
  host: { class: 'grid gap-5' },
  templateUrl: './app-fields.html',
})
export class AppFields {
  readonly fields = input.required<AppField[]>();
  /** The values now (from the `.env` being edited), by key. */
  readonly values = input.required<ReadonlyMap<string, string>>();
  /** The template the fields' texts come from. */
  readonly templateId = input<string | null>(null);
  readonly versions = input<ReadonlyMap<string, VersionList>>(new Map());
  readonly disabled = input(false);
  readonly changed = output<FieldChange>();
  readonly kindChanged = output<{ key: string; kind: FieldKind }>();
  readonly askVersions = output<string>();

  protected readonly kinds = SHOWN_KINDS;
  protected readonly main = computed(() =>
    this.fields().filter((f) => !f.advanced && f.kind !== 'generated'),
  );
  protected readonly advanced = computed(() =>
    this.fields().filter((f) => f.advanced || f.kind === 'generated'),
  );

  protected value(field: AppField): string {
    return this.values().get(field.key) ?? field.value;
  }

  protected label(field: AppField): string | null {
    const id = this.templateId();
    return field.fromTemplate && id ? `catalog.${id}.fields.${field.key}.label` : null;
  }

  protected help(field: AppField): string | null {
    const id = this.templateId();
    return field.fromTemplate && id ? `catalog.${id}.fields.${field.key}.help` : null;
  }

  protected inputType(field: AppField): string {
    return field.kind === 'secret' || field.kind === 'generated' ? 'password' : 'text';
  }

  protected edit(field: AppField, event: Event): void {
    this.changed.emit({ key: field.key, value: (event.target as HTMLInputElement).value });
  }

  protected pickVersion(field: AppField, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value) this.changed.emit({ key: field.key, value });
  }

  protected setKind(field: AppField, event: Event): void {
    this.kindChanged.emit({
      key: field.key,
      kind: (event.target as HTMLSelectElement).value as FieldKind,
    });
  }
}
