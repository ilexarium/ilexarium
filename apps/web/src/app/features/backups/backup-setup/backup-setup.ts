import { Component, computed, inject, input, output, signal } from '@angular/core';
import { form, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
  type BackupDestination,
  type BackupFoldersResponse,
  type BackupSettingsForm,
  backupSettingsFormSchema,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_BACKUP_SCHEDULE,
} from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolderPlus, lucideHardDrive, lucideTrash2 } from '@ng-icons/lucide';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmFieldImports } from '@ui/field';
import { ErrorTextPipe } from '../../../shared/forms/error-text-pipe';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { Formatter } from '../../../shared/format/formatter';
import { BackupsPageStore } from '../backups-page/backups-page-store';
import type { AppSummary } from '@laris/shared';
import { FolderPicker } from '../folder-picker/folder-picker';
import { RetentionFields } from '../retention-fields/retention-fields';
import { ScheduleFields } from '../schedule-fields/schedule-fields';

/**
 * Setting backups up, once: the disk (mounted ones under /mnt and /media, free space, a warning
 * when it holds the data too), when and how long (presets, numbers under "Advanced"), and what
 * (apps ticked, folders added; this app itself always). "Set up backups" creates
 * the repository; its passphrase is shown next. Submits through the page store.
 */
@Component({
  selector: 'laris-backup-setup',
  imports: [
    ErrorTextPipe,
    FolderPicker,
    FormErrors,
    FormRoot,
    HlmAlertImports,
    HlmButton,
    HlmCardImports,
    HlmFieldImports,
    NgIcon,
    RetentionFields,
    RouterLink,
    ScheduleFields,
    TranslatePipe,
  ],
  providers: [provideIcons({ lucideFolderPlus, lucideHardDrive, lucideTrash2 })],
  templateUrl: './backup-setup.html',
})
export class BackupSetup {
  /** Null while loading. */
  readonly destinations = input<BackupDestination[] | null>(null);
  readonly apps = input<AppSummary[]>([]);
  /** The folder picker's place (the page store loads it). */
  readonly folderListing = input<BackupFoldersResponse | null>(null);

  readonly browse = output<string | undefined>();
  readonly closeBrowser = output<void>();

  private readonly backupsPageStore = inject(BackupsPageStore);
  protected readonly formatter = inject(Formatter);

  /** Apps switched off (all are on at first). */
  protected readonly skippedApps = signal<string[]>([]);
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
          const skipped = this.skippedApps();
          try {
            await this.backupsPageStore.setup(
              value,
              this.apps()
                .map((app) => app.name)
                .filter((name) => !skipped.includes(name)),
              this.folders(),
            );
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

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected toggleApp(name: string, on: boolean): void {
    this.skippedApps.update((list) => (on ? list.filter((s) => s !== name) : [...list, name]));
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
