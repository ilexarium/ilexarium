import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { type JournalPriority, systemServiceNameSchema } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideListFilter } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmSkeleton } from '@ui/skeleton';
import { map } from 'rxjs';
import { Translator } from '../../../core/i18n/translator';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import { Formatter } from '../../../shared/format/formatter';
import { LogView } from '../../../shared/log-view/log-view';
import type { BootChoice } from '../system-journal.model';
import { PRIORITY_CHOICES } from './journal-page.constants';
import { JournalPageStore } from './journal-page-store';

/**
 * The Logs page (docs/plans/system_logs.md): the machine's journal, newest at the bottom and
 * following; one service (`?unit=`), a priority and a boot to choose; older lines on request.
 * Fills the screen height below the top bar, so the log box scrolls, not the page.
 */
@Component({
  selector: 'laris-journal-page',
  imports: [
    EmptyState,
    HlmAlertImports,
    HlmButton,
    HlmInput,
    HlmSkeleton,
    LogView,
    NgIcon,
    TranslatePipe,
  ],
  providers: [JournalPageStore, provideIcons({ lucideListFilter })],
  host: {
    // The viewport minus the top bar (3.5rem) and the page padding (1rem / 1.5rem each side).
    class: 'flex h-[calc(100dvh-5.5rem)] min-h-96 flex-col gap-3 md:h-[calc(100dvh-6.5rem)]',
  },
  templateUrl: './journal-page.html',
})
export class JournalPage {
  protected readonly journalPageStore = inject(JournalPageStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);
  protected readonly priorities = PRIORITY_CHOICES;
  /** Phones: the filters fold away behind a button. */
  protected readonly filtersShown = signal(false);

  private readonly unitParam = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('unit'))),
    { requireSync: true },
  );
  private readonly unit = computed(() => {
    const unit = this.unitParam();
    return unit && systemServiceNameSchema.safeParse(unit).success ? unit : null;
  });

  constructor() {
    effect(() => {
      const unit = this.unit();
      untracked(() => this.journalPageStore.setFilters({ unit }));
    });
  }

  protected bootLabel(choice: BootChoice): string {
    const span = {
      first: choice.first ? this.formatter.dateTime(choice.first) : '',
      last: choice.last ? this.formatter.dateTime(choice.last) : '',
      count: -choice.offset,
    };
    const timed = choice.first ? 'Since' : '';
    if (choice.offset === 0) return this.translator.t(`journal.boot.current${timed}`, span);
    if (choice.offset === -1) return this.translator.t(`journal.boot.previous${timed}`, span);
    return this.translator.plural('journal.boot.earlier', span.count, span);
  }

  protected chooseUnit(event: Event): void {
    const unit = (event.target as HTMLSelectElement).value || null;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { unit },
      replaceUrl: true,
    });
  }

  protected choosePriority(event: Event): void {
    const priority = (event.target as HTMLSelectElement).value as JournalPriority;
    this.journalPageStore.setFilters({ priority });
  }

  protected chooseBoot(event: Event): void {
    this.journalPageStore.setFilters({ boot: (event.target as HTMLSelectElement).value || null });
  }
}
