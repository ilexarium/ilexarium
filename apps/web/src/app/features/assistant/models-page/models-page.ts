import { Component, computed, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, validateStandardSchema } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { type AiPullRequest, aiLibrarySearchSchema, aiPullRequestSchema } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideSearch } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmFieldImports } from '@ui/field';
import { HlmInput } from '@ui/input';
import { HlmSkeleton } from '@ui/skeleton';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { Formatter } from '../../../shared/format/formatter';
import { InstalledModels } from '../installed-models/installed-models';
import { LibraryResults } from '../library-results/library-results';
import { PullProgress } from '../pull-progress/pull-progress';
import { ModelsPageStore } from './models-page-store';
import { FieldErrors } from '../../../shared/forms/field-errors';

/**
 * The Assistant's models (docs/plans/ai_assistant.md): the installed ones, downloading one by
 * name or from Hugging Face, and the download's progress.
 */
@Component({
  selector: 'laris-models-page',
  imports: [
    EmptyState,
    FieldErrors,
    FormField,
    FormRoot,
    HlmButton,
    HlmFieldImports,
    HlmInput,
    HlmSkeleton,
    InstalledModels,
    LibraryResults,
    NgIcon,
    PullProgress,
    RouterLink,
    TranslatePipe,
  ],
  providers: [ModelsPageStore, provideIcons({ lucideArrowLeft, lucideSearch })],
  templateUrl: './models-page.html',
})
export class ModelsPage {
  protected readonly modelsPageStore = inject(ModelsPageStore);
  protected readonly formatter = inject(Formatter);
  protected readonly installedNames = computed(() =>
    this.modelsPageStore.models().map((m) => m.name),
  );

  private readonly byName = signal<AiPullRequest>({ model: '' });
  protected readonly pullForm = form(
    this.byName,
    (path) => validateStandardSchema(path, aiPullRequestSchema),
    {
      submission: {
        action: async (field) => {
          try {
            await this.modelsPageStore.download(field().value().model.trim());
          } catch {
            return undefined; // Told in a toast; the name stays.
          }
          this.pullForm().reset({ model: '' });
          return undefined;
        },
      },
    },
  );

  private readonly query = signal({ search: '' });
  protected readonly searchForm = form(
    this.query,
    (path) => validateStandardSchema(path, aiLibrarySearchSchema),
    {
      submission: {
        action: async (field) => {
          await this.modelsPageStore.search(field().value().search.trim());
          return undefined;
        },
      },
    },
  );

  protected async download(model: string): Promise<void> {
    try {
      await this.modelsPageStore.download(model);
    } catch {
      // Told in a toast.
    }
  }
}
