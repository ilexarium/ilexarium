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
import type { LogEntry } from '../logs-page/log-stream';
import { LogPreferences } from './log-preferences';

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
 * - **stderr** lines carry an icon and the word "stderr", not colour alone.
 * - **Timestamps** (local time) and **wrap** are toggles, remembered per browser. Without wrap,
 *   long lines scroll sideways inside the log box — never the page.
 *
 * A plain list, not virtual scrolling: lines may wrap to any height, and Ctrl+F and copying many
 * lines keep working. Off-screen lines skip rendering (`content-visibility: auto`); at most
 * `LOG_LIMITS.maxLinesInView` lines are kept. Log text is always rendered as text, never HTML.
 */
@Component({
  selector: 'app-log-view',
  imports: [HlmButton, HlmInput, LogTimePipe, NgIcon],
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
  template: `
    <div class="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Log controls">
      <div class="relative min-w-0 flex-1 basis-40">
        <ng-icon
          name="lucideSearch"
          class="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <label for="log-filter" class="sr-only">Filter lines</label>
        <input
          hlmInput
          id="log-filter"
          type="search"
          class="w-full ps-8"
          placeholder="Filter"
          autocomplete="off"
          [value]="filter()"
          (input)="filter.set($any($event.target).value)"
        />
      </div>
      <button hlmBtn variant="outline" [attr.aria-pressed]="paused()" (click)="togglePause()">
        <ng-icon [name]="paused() ? 'lucidePlay' : 'lucidePause'" aria-hidden="true" />
        <span class="sr-only sm:not-sr-only">{{ paused() ? 'Resume' : 'Pause' }}</span>
      </button>
      <button
        hlmBtn
        variant="outline"
        [attr.aria-pressed]="prefs.timestamps()"
        (click)="prefs.setTimestamps(!prefs.timestamps())"
      >
        <ng-icon name="lucideClock" aria-hidden="true" />
        <span class="sr-only sm:not-sr-only">Timestamps</span>
      </button>
      <button
        hlmBtn
        variant="outline"
        [attr.aria-pressed]="prefs.wrap()"
        (click)="prefs.setWrap(!prefs.wrap())"
      >
        <ng-icon name="lucideWrapText" aria-hidden="true" />
        <span class="sr-only sm:not-sr-only">Wrap lines</span>
      </button>
    </div>
    @if (filter()) {
      <p class="text-xs text-muted-foreground">{{ matchSummary() }}</p>
    }

    <div class="relative flex min-h-0 flex-1 flex-col">
      <ol
        #box
        tabindex="0"
        aria-label="Log lines"
        class="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/40 py-2 font-mono text-xs leading-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        (scroll)="onScroll()"
      >
        @for (entry of visible(); track entry.id) {
          @if (entry.kind === 'line') {
            <li
              class="flex min-w-full flex-col px-3 [contain-intrinsic-block-size:auto_1.25rem] [content-visibility:auto] sm:flex-row sm:gap-3"
              [class]="{ 'w-max': !prefs.wrap(), 'bg-destructive/10': entry.stream === 'stderr' }"
            >
              @if (prefs.timestamps() || entry.stream === 'stderr') {
                <span class="flex shrink-0 items-center gap-2">
                  @if (prefs.timestamps()) {
                    <time class="text-muted-foreground" [attr.datetime]="entry.at">{{
                      entry.at | logTime
                    }}</time>
                  }
                  @if (entry.stream === 'stderr') {
                    <span class="inline-flex items-center gap-1 font-medium text-destructive">
                      <ng-icon name="lucideTriangleAlert" aria-hidden="true" />stderr
                    </span>
                  }
                </span>
              }
              <span
                class="min-w-0"
                [class]="prefs.wrap() ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre'"
                >{{ entry.text }}</span
              >
            </li>
          } @else {
            <li class="px-3 text-center text-muted-foreground italic">
              {{ entry.count }} {{ entry.count === 1 ? 'line' : 'lines' }} skipped (too many at
              once)
            </li>
          }
        } @empty {
          @if (filter()) {
            <li class="px-3 text-muted-foreground">No lines match “{{ filter() }}”.</li>
          }
        }
      </ol>
      @if (!pinned()) {
        <button hlmBtn size="sm" class="absolute end-3 bottom-3 shadow-md" (click)="jumpToLatest()">
          <ng-icon name="lucideArrowDownToLine" aria-hidden="true" />
          Jump to latest
        </button>
      }
    </div>
  `,
})
export class LogView {
  /** Oldest first. */
  readonly entries = input.required<LogEntry[]>();

  protected readonly prefs = inject(LogPreferences);
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
      (entry) => entry.kind === 'line' && entry.text.toLowerCase().includes(query),
    );
  });

  protected readonly matchSummary = computed(() => {
    const total = this.entries().filter((entry) => entry.kind === 'line').length;
    const shown = this.visible().length;
    return `${shown} of ${total} ${total === 1 ? 'line matches' : 'lines match'}`;
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
