import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  inject,
  Injector,
  input,
  type OnInit,
  signal,
  type WritableSignal,
} from '@angular/core';
import {
  type FieldTree,
  form,
  FormField,
  FormRoot,
  validateStandardSchema,
} from '@angular/forms/signals';
import { Router } from '@angular/router';
import {
  type CatalogEntryDetails,
  defaultValues,
  type FieldValue,
  type FieldValues,
  isUserField,
  type UserField,
  valuesSchema,
} from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { HlmSelectImports } from '@ui/select';
import { InstallPageStore } from '../install-page/install-page-store';
import { PasswordToggle } from '../../../shared/forms/password-toggle';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';

/** One line of the access summary: what the service will be able to do. */
interface AccessItem {
  key: string;
  params: Record<string, string | number>;
  /** Machine text (ports, folders): shown left to right. */
  ltr: string | null;
}

/** The Install button below the access summary is the confirmation. */
@Component({
  selector: 'laris-install-form',
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
    NgTemplateOutlet,
    PasswordToggle,
    TranslatePipe,
  ],
  templateUrl: './install-form.html',
})
export class InstallForm implements OnInit {
  readonly details = input.required<CatalogEntryDetails>();

  private readonly installPageStore = inject(InstallPageStore);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  protected readonly showSecrets = signal(false);
  /** "Include in backups" (ticked; only shown when a backup plan exists). */
  protected readonly includeInBackups = signal(true);
  protected readonly canIncludeInBackups = this.installPageStore.canIncludeInBackups;
  protected model!: WritableSignal<FieldValues>;
  protected form!: FieldTree<FieldValues>;

  protected readonly id = computed(() => this.details().meta.id);
  protected readonly fields = computed(() => this.details().meta.fields.filter(isUserField));
  protected readonly mainFields = computed(() => this.fields().filter((f) => !f.advanced));
  protected readonly advancedFields = computed(() => this.fields().filter((f) => f.advanced));
  protected readonly generatesSecrets = computed(() =>
    this.details().meta.fields.some((f) => f.type === 'generatedSecret'),
  );

  ngOnInit(): void {
    const details = this.details();
    const schema = valuesSchema(details.meta, { keptSecrets: details.keptSecrets });
    const start = defaultValues(details.meta);
    for (const key of Object.keys(start)) {
      const suggested = details.suggested[key];
      if (suggested !== undefined) start[key] = suggested;
    }
    this.model = signal(start);
    this.form = form(this.model, (path) => validateStandardSchema(path, schema), {
      injector: this.injector,
      submission: {
        action: async (tree) => {
          try {
            await this.installPageStore.deploy(tree().value(), this.includeInBackups());
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          // Progress is shown on the services page, live.
          void this.router.navigate(['/services']);
          return undefined;
        },
      },
    });
  }

  protected field(key: string): FieldTree<FieldValue> {
    return this.form[key] as FieldTree<FieldValue>;
  }

  // Each control binds a field of its own type; the schema guarantees the type per field kind.
  protected numberField(key: string): FieldTree<number> {
    return this.form[key] as unknown as FieldTree<number>;
  }

  protected textField(key: string): FieldTree<string> {
    return this.form[key] as unknown as FieldTree<string>;
  }

  protected booleanField(key: string): FieldTree<boolean> {
    return this.form[key] as unknown as FieldTree<boolean>;
  }

  protected setIncludeInBackups(event: Event): void {
    this.includeInBackups.set((event.target as HTMLInputElement).checked);
  }

  protected kept(field: UserField): boolean {
    return this.details().keptSecrets.includes(field.key);
  }

  /** Open "Advanced" when one of its fields has an error to show. */
  protected readonly advancedOpen = computed(() =>
    this.advancedFields().some((f) => this.field(f.key)().errors().length > 0),
  );

  protected readonly access = computed((): AccessItem[] => {
    const values = this.model();
    const items: AccessItem[] = [];
    for (const field of this.fields()) {
      const value = values[field.key];
      if (field.type === 'port') {
        items.push({
          key: 'services.access.port',
          params: { port: Number(value) },
          ltr: String(value),
        });
      } else if (field.type === 'path') {
        items.push({
          key: field.access === 'read' ? 'services.access.read' : 'services.access.write',
          params: {},
          ltr: String(value),
        });
      }
    }
    if (this.details().volumes.length > 0)
      items.push({ key: 'services.access.volumes', params: {}, ltr: null });
    if (this.generatesSecrets())
      items.push({ key: 'services.access.generatedSecrets', params: {}, ltr: null });
    return items;
  });
}
