import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import {
  DISK_MOUNT_ROOT,
  type DiskMountRequest,
  diskMountRequestSchema,
  suggestDiskName,
} from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { toSubmissionErrors } from '../../../shared/forms/submission-errors';
import { FieldErrors } from '../../../shared/forms/field-errors';
import { FormErrors } from '../../../shared/forms/form-errors';
import { DisksPageStore } from '../disks-page/disks-page-store';
import type { MountTarget } from '../disks.model';

/**
 * Mounting a disk: the folder it's mounted at (`/mnt/<name>` suggested from the disk's label;
 * anywhere but a system folder), whether its top folder becomes the signed-in account's, and
 * that it stays mounted after a restart. The confirm button is the confirmation. Submits through
 * the page store, as the person (their sudo).
 */
@Component({
  selector: 'laris-mount-dialog',
  imports: [
    FieldErrors,
    FormErrors,
    FormField,
    FormRoot,
    HlmAlertDialogImports,
    HlmAlertImports,
    HlmButton,
    HlmFieldImports,
    HlmInput,
    TranslatePipe,
  ],
  templateUrl: './mount-dialog.html',
})
export class MountDialog {
  private readonly disksPageStore = inject(DisksPageStore);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  protected readonly target = signal<MountTarget | null>(null);
  private readonly model = signal<DiskMountRequest>({ uuid: '', mountPoint: '', makeMine: false });
  protected readonly form = form(
    this.model,
    (path) => validateStandardSchema(path, diskMountRequestSchema),
    {
      submission: {
        action: async (tree) => {
          try {
            if (!(await this.disksPageStore.mount(tree().value()))) return undefined;
          } catch (error) {
            return toSubmissionErrors(error, tree);
          }
          this.close();
          return undefined;
        },
      },
    },
  );

  protected readonly title = computed(() => {
    const target = this.target();
    return target?.partition.label ?? target?.diskName ?? '';
  });

  open(target: MountTarget, taken: readonly string[]): void {
    this.target.set(target);
    this.form().reset({
      uuid: target.partition.uuid ?? '',
      mountPoint: `${DISK_MOUNT_ROOT}/${suggestDiskName(target.partition.label, taken)}`,
      makeMine: false,
    });
    this.dialog().open();
  }

  protected close(): void {
    this.dialog().close();
    this.target.set(null);
  }
}
