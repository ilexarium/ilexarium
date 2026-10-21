import { Component, inject, viewChild } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePause, lucidePlay, lucideSearch } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { EndProcessDialog } from '../end-process-dialog/end-process-dialog';
import { ProcessList } from '../process-list/process-list';
import { PROCESS_SORTS, type EndRequest } from '../processes.model';
import { ProcessesPageStore } from './processes-page-store';

/**
 * The Processes page (docs/plans/process_list.md): what runs on the machine, live — search, sort,
 * pause, system processes on demand — and ending a person's runaway process, confirmed.
 */
@Component({
  selector: 'laris-processes-page',
  imports: [
    EndProcessDialog,
    HlmAlertImports,
    HlmButton,
    HlmInput,
    HlmSkeleton,
    NgIcon,
    PluralPipe,
    ProcessList,
    TranslatePipe,
  ],
  providers: [ProcessesPageStore, provideIcons({ lucidePause, lucidePlay, lucideSearch })],
  templateUrl: './processes-page.html',
})
export class ProcessesPage {
  protected readonly store = inject(ProcessesPageStore);
  protected readonly sorts = PROCESS_SORTS;
  private readonly dialog = viewChild.required(EndProcessDialog);

  protected ask(request: EndRequest): void {
    this.dialog().open(request);
  }

  protected search(event: Event): void {
    this.store.setSearch((event.target as HTMLInputElement).value);
  }

  protected showSystem(event: Event): void {
    this.store.setShowSystem((event.target as HTMLInputElement).checked);
  }
}
