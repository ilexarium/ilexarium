import { Component, inject, Injector, signal, viewChild } from '@angular/core';
import {
  type FieldTree,
  form,
  FormField,
  FormRoot,
  validateStandardSchema,
} from '@angular/forms/signals';
import { FILES_LIMITS, fileNameSchema } from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { z } from 'zod';
import { FilesPageStore } from '../files-page/files-page-store';
import type { NameRequest } from '../files.model';
import { FieldErrors } from '../../../shared/forms/field-errors';

/** A new name or path: renaming may also move it (a path, from the folder shown or from /). */
const renameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'validation.fileNameRequired')
    .max(FILES_LIMITS.pathMax, 'validation.fileNameTooLong')
    .refine((value) => !value.includes('\0'), 'validation.fileNameInvalid'),
});
const newFolderSchema = z.object({ name: fileNameSchema });

/** A new folder's name, or a new name (or path) for an entry. Submits through the page store. */
@Component({
  selector: 'app-file-name-dialog',
  imports: [
    FieldErrors,
    FormField,
    FormRoot,
    HlmAlertDialogImports,
    HlmButton,
    HlmFieldImports,
    HlmInput,
    TranslatePipe,
  ],
  templateUrl: './file-name-dialog.html',
})
export class FileNameDialog {
  private readonly store = inject(FilesPageStore);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild.required(HlmAlertDialog);
  protected readonly request = signal<NameRequest | null>(null);
  protected readonly form = signal<FieldTree<{ name: string }> | null>(null);

  open(request: NameRequest): void {
    this.request.set(request);
    const model = signal({ name: request.kind === 'rename' ? request.entry.name : '' });
    this.form.set(
      form(
        model,
        (path) =>
          validateStandardSchema(path, request.kind === 'rename' ? renameSchema : newFolderSchema),
        {
          injector: this.injector,
          submission: {
            action: async (tree) => {
              const { name } = tree().value();
              const done =
                request.kind === 'rename'
                  ? await this.store.rename(request.entry, name)
                  : await this.store.newFolder(name.trim());
              if (done) this.close();
              return undefined;
            },
          },
        },
      ),
    );
    this.dialog().open();
  }

  protected close(): void {
    this.dialog().close();
  }
}
