import {
  afterNextRender,
  Component,
  type ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import type { LinuxSignInRequest, Process } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePause, lucidePlay, lucideSearch, lucideX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { EndProcessDialog } from '../end-process-dialog/end-process-dialog';
import { ProcessList } from '../process-list/process-list';
import { ProcessSummary } from '../process-summary/process-summary';
import { SignInDialog } from '../../../shared/sign-in-dialog/sign-in-dialog';
import type { EndRequest, ProcessSort } from '../processes.model';
import { ProcessesPageStore } from './processes-page-store';
import { PHONE_SORTS } from './processes-page.constants';

/**
 * The Processes page (docs/plans/process_list.md): what runs on the machine, live, like htop —
 * with a header of its own (how busy, who is it) — and ending a process as the signed-in Linux
 * account: its own confirmed, another's through its sudo with its password. Signing in to Linux
 * comes first when there is no Linux session yet.
 */
@Component({
  selector: 'ilex-processes-page',
  imports: [
    EndProcessDialog,
    HlmAlertImports,
    HlmButton,
    HlmInput,
    HlmSkeleton,
    NgIcon,
    PluralPipe,
    ProcessList,
    ProcessSummary,
    SignInDialog,
    TranslatePipe,
  ],
  providers: [ProcessesPageStore, provideIcons({ lucidePause, lucidePlay, lucideSearch, lucideX })],
  templateUrl: './processes-page.html',
})
export class ProcessesPage {
  protected readonly store = inject(ProcessesPageStore);
  protected readonly phoneSorts = PHONE_SORTS;
  private readonly injector = inject(Injector);
  private readonly endDialog = viewChild.required(EndProcessDialog);
  private readonly searchBox = viewChild.required<ElementRef<HTMLInputElement>>('searchBox');
  protected readonly signInOpen = signal(false);
  /** Asked before there was a Linux session: goes on once signed in. */
  private waiting: EndRequest | null = null;

  protected readonly endAs = (process: Process) => this.store.endAs(process);
  protected readonly signIn = (request: LinuxSignInRequest) => this.store.signIn(request);

  protected ask(request: EndRequest): void {
    if (!this.store.linux()) {
      this.waiting = request;
      this.signInOpen.set(true);
      return;
    }
    this.confirm(request);
  }

  protected signInClosed(): void {
    this.signInOpen.set(false);
    const request = this.waiting;
    this.waiting = null;
    // After the sign-in dialog has gone (one dialog at a time).
    if (request && this.store.linux()) {
      afterNextRender(() => this.confirm(request), { injector: this.injector });
    }
  }

  protected search(event: Event): void {
    this.store.setSearch((event.target as HTMLInputElement).value);
  }

  protected focusSearch(): void {
    this.searchBox().nativeElement.focus();
  }

  protected showSystem(event: Event): void {
    this.store.setShowSystem((event.target as HTMLInputElement).checked);
  }

  protected sortBy(event: Event): void {
    this.store.setSort((event.target as HTMLSelectElement).value as ProcessSort);
  }

  private confirm(request: EndRequest): void {
    this.endDialog().open(request, this.store.endAs(request.process) === 'administrator');
  }
}
