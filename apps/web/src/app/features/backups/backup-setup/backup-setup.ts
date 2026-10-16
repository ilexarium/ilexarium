import { Component, computed, inject, input, output, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
  BACKUP_FREQUENCIES,
  type BackupDestination,
  type BackupFoldersResponse,
  type BackupSettingsForm,
  backupSettingsFormSchema,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_BACKUP_SCHEDULE,
} from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolderPlus, lucideHardDrive, lucideTrash2 } from '@ng-icons/lucide';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { HlmSelectImports } from '@ui/select';
import { Translator } from '../../../core/i18n/translator';
import { ErrorTextPipe } from '../../../shared/forms/error-text-pipe';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { Formatter } from '../../../shared/format/formatter';
import { BackupsPageStore } from '../backups-page/backups-page-store';
import type { BackupableService } from '../backups.model';
import { FolderPicker } from '../folder-picker/folder-picker';

/**
 * Setting backups up, once: the disk (mounted ones under /mnt and /media, free space, a warning
 * when it holds the data too), when and how long (presets, numbers under "Advanced"), and what
 * (installed services ticked, folders added; this app itself always). "Set up backups" creates
 * the repository; its passphrase is shown next. Submits through the page store.
 */
@Component({
  selector: 'app-backup-setup',
  imports: [
    ErrorTextPipe,
    FolderPicker,
    FormField,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmCardImports,
    HlmFieldImports,
    HlmInput,
    HlmSelectImports,
    NgIcon,
    RouterLink,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideFolderPlus, lucideHardDrive, lucideTrash2 })],
  templateUrl: './backup-setup.html',
})
export class BackupSetup {
  /** Null while loading. */
  readonly destinations = input<BackupDestination[] | null>(null);
  readonly services = input<BackupableService[]>([]);
  /** The folder picker's place (the page store loads it). */
  readonly folderListing = input<BackupFoldersResponse | null>(null);

  readonly browse = output<string | undefined>();
  readonly closeBrowser = output<void>();

  private readonly store = inject(BackupsPageStore);
  protected readonly format = inject(Formatter);
  protected readonly frequencies = BACKUP_FREQUENCIES;
  private readonly translator = inject(Translator);
  /** What the select shows for the chosen frequency. */
  protected readonly frequencyLabel = (frequency: string) =>
    this.translator.t(`backups.schedule.${frequency}`);
  protected readonly keepParts = ['daily', 'weekly', 'monthly'] as const;

  /** Services switched off (all are on at first). */
  protected readonly skippedServices = signal<string[]>([]);
  /** A service's folders switched off, by service id. */
  protected readonly excluded = signal<Record<string, string[]>>({});
  protected readonly folders = signal<string[]>([]);
  protected readonly pickerOpen = signal(false);

  private readonly model = signal<BackupSettingsForm>({
    destination: '',
    schedule: { ...DEFAULT_BACKUP_SCHEDULE },
    retention: { ...DEFAULT_BACKUP_RETENTION },
  });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, backupSettingsFormSchema),
    {
      submission: {
        action: async (tree) => {
          const value = tree().value();
          const skipped = this.skippedServices();
          try {
            await this.store.setup({
              ...value,
              items: [
                ...this.services()
                  .filter((s) => !skipped.includes(s.id))
                  .map((s) => ({
                    kind: 'service' as const,
                    serviceId: s.id,
                    excludedFields: this.excluded()[s.id] ?? [],
                  })),
                ...this.folders().map((path) => ({ kind: 'folder' as const, path })),
              ],
            });
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          return undefined;
        },
      },
    },
  );

  protected readonly chosen = computed(
    () =>
      (this.destinations() ?? []).find((d) => d.mountPoint === this.model().destination) ?? null,
  );

  protected keep(part: (typeof this.keepParts)[number]) {
    return this.form.retention[part];
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected toggleService(id: string, on: boolean): void {
    this.skippedServices.update((list) => (on ? list.filter((s) => s !== id) : [...list, id]));
  }

  protected toggleFolder(service: BackupableService, field: string, on: boolean): void {
    this.excluded.update((all) => {
      const current = all[service.id] ?? [];
      return {
        ...all,
        [service.id]: on ? current.filter((f) => f !== field) : [...current, field],
      };
    });
  }

  /** At least one folder of a service stays on. */
  protected lastFolder(service: BackupableService, field: string): boolean {
    const off = this.excluded()[service.id] ?? [];
    return !off.includes(field) && off.length === service.folders.length - 1;
  }

  protected openPicker(): void {
    this.pickerOpen.set(true);
    this.browse.emit(undefined);
  }

  protected chooseFolder(path: string): void {
    this.folders.update((list) => (list.includes(path) ? list : [...list, path]));
    this.closePicker();
  }

  protected closePicker(): void {
    this.pickerOpen.set(false);
    this.closeBrowser.emit();
  }

  protected removeFolder(path: string): void {
    this.folders.update((list) => list.filter((p) => p !== path));
  }
}
