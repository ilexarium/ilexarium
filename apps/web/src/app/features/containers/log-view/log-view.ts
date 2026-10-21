import {
  afterRenderEffect,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  Pipe,
  type PipeTransform,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDownToLine,
  lucideClock,
  lucidePause,
  lucidePlay,
  lucideSearch,
  lucideTriangleAlert,
  lucideWrapText,
} from '@ng-icons/lucide';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { formatLogTime } from '../../../shared/format/format';
import { LogPreferences } from './log-preferences';
import type { LogEntry } from '../containers.model';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../../../core/i18n/translator';

/** Within this many pixels of the bottom counts as "at the bottom" (following). */
const BOTTOM_SLACK_PX = 16;

/** Pure: each line's time is formatted once, not on every batch. */
@Pipe({ name: 'logTime' })
export class LogTimePipe implements PipeTransform {
  transform(at: string): string {
    return formatLogTime(at);
  }
}

/**
 * A container's log lines, following new ones like `docker logs -f`:
 *
 * - **Following:** keeps the newest line in view while at the bottom. Scrolling up stops it and
 *   offers **Jump to latest**; **Pause** stops it explicitly.
 * - **Filter:** case-insensitive, over the lines loaded.
 * - **stderr** lines carry an icon and the word "stderr", not colour alone. The line itself isn't
 *   tinted: many services (Navidrome, most Go and Python programs) write all their logs to
 *   stderr, so it marks the channel, not an error.
 * - **Timestamps** (local time) and **wrap** are toggles, remembered per browser. Without wrap,
 *   long lines scroll sideways inside the log box — never the page.
 *
 * A plain list, not virtual scrolling: lines may wrap to any height, and Ctrl+F and copying many
 * lines keep working. Off-screen lines skip rendering (`content-visibility: auto`); at most
 * `LOG_LIMITS.maxLinesInView` lines are kept. Log text is always rendered as text, never HTML.
 */
@Component({
  selector: 'laris-log-view',
  imports: [HlmButton, HlmInput, LogTimePipe, NgIcon, TranslatePipe],
  providers: [
    provideIcons({
      lucideArrowDownToLine,
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
  readonly entries = input.required<LogEntry[]>();

  protected readonly prefs = inject(LogPreferences);
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
    return entries.filter((entry) => entry.text.toLowerCase().includes(query));
  });

  protected readonly matchSummary = computed(() => {
    const total = this.entries().length;
    const shown = this.visible().length;
    return this.translator.plural('logs.matches', total, { shown });
  });

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
