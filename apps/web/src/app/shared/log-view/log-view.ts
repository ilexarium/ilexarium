import {
  afterRenderEffect,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDownToLine,
  lucideChevronsUp,
  lucideCircleAlert,
  lucideClock,
  lucidePause,
  lucidePlay,
  lucideSearch,
  lucideTriangleAlert,
  lucideWrapText,
} from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { LogPreferences } from './log-preferences';
import { LogTimePipe } from './log-time-pipe';
import { BOTTOM_SLACK_PX, ERROR_PRIORITY, MARKED_PRIORITY } from './log-view.constants';
import type { LogViewEntry } from './log-view.model';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../../core/i18n/translator';

/**
 * Follows new lines while at the bottom, like `docker logs -f`; scrolling up or Pause stops it.
 *
 * - **stderr** lines carry an icon and the word "stderr", not colour alone. The line itself isn't
 *   tinted: many services (Navidrome, most Go and Python programs) write all their logs to
 *   stderr, so it marks the channel, not an error.
 * - A plain list, not virtual scrolling: lines may wrap to any height, and Ctrl+F and copying many
 *   lines keep working. Off-screen lines skip rendering (`content-visibility: auto`).
 * - Log text is always rendered as text, never HTML (it can hold anything).
 * - Journal lines carry who wrote them, and warnings and worse a mark and a word (not colour
 *   alone); "Load older" above the first line when there's more.
 */
@Component({
  selector: 'ilex-log-view',
  imports: [HlmButton, HlmInput, LogTimePipe, NgIcon, TranslatePipe],
  providers: [
    provideIcons({
      lucideArrowDownToLine,
      lucideChevronsUp,
      lucideCircleAlert,
      lucideClock,
      lucidePause,
      lucidePlay,
      lucideSearch,
      lucideTriangleAlert,
      lucideWrapText,
    }),
  ],
  host: { class: 'flex min-h-0 flex-col gap-2' },
  templateUrl: './log-view.html',
})
export class LogView {
  /** Oldest first. */
  readonly entries = input.required<LogViewEntry[]>();
  /** Older lines can be asked for ("Load older" above the first line). */
  readonly canLoadOlder = input(false);
  readonly loadingOlder = input(false);
  readonly loadOlder = output<void>();

  protected readonly logPreferences = inject(LogPreferences);
  private readonly translator = inject(Translator);
  protected readonly filter = signal('');
  /** Following stopped with the Pause button. */
  protected readonly paused = signal(false);
  /** The view is at the bottom (scrolling up unsets it). */
  protected readonly pinned = signal(true);

  private readonly box = viewChild.required<ElementRef<HTMLElement>>('box');

  protected readonly visible = computed(() => {
    const query = this.filter().trim().toLowerCase();
    const entries = this.entries();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.text.toLowerCase().includes(query) || !!entry.source?.toLowerCase().includes(query),
    );
  });

  protected readonly matchSummary = computed(() => {
    const total = this.entries().length;
    const shown = this.visible().length;
    return this.translator.plural('logs.matches', total, { shown });
  });

  protected readonly markedPriority = MARKED_PRIORITY;
  protected readonly errorPriority = ERROR_PRIORITY;

  constructor() {
    // After each render with new lines: keep the newest in view while following.
    afterRenderEffect(() => {
      this.visible();
      if (!this.paused() && this.pinned()) this.scrollToBottom();
    });
  }

  protected onScroll(): void {
    const box = this.box().nativeElement;
    this.pinned.set(box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK_PX);
  }

  protected togglePause(): void {
    if (this.paused()) {
      this.jumpToLatest();
    } else {
      this.paused.set(true);
    }
  }

  protected jumpToLatest(): void {
    this.paused.set(false);
    this.pinned.set(true);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    const box = this.box().nativeElement;
    box.scrollTop = box.scrollHeight;
  }
}
