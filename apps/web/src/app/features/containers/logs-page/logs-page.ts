import { Component, computed, effect, inject, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft } from '@ng-icons/lucide';
import { containerNameSchema, type LogsEndReason } from '@homelab/shared';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { map } from 'rxjs';
import { LogView } from '../log-view/log-view';
import { LogStream } from './log-stream';
import { TranslatePipe } from '@ngx-translate/core';

interface Notice {
  /** Translation keys `<key>.title`, `<key>.text` and, if it can help, `<key>.retry`. */
  key: string;
  params?: Record<string, string>;
  /** Problems are announced at once (`alert`); the rest politely (`status`). */
  problem: boolean;
  /** A button that opens the stream again. */
  retry: boolean;
}

/**
 * One container's logs, live (`/containers/:name/logs`, titled "Logs · <name>"). Fills the screen
 * height below the top bar, so the log box scrolls, not the page. Says in plain words why there
 * are no (more) lines: loading, no output yet, stopped, removed, not found, not readable, Docker
 * not reachable, too many log views.
 */
@Component({
  selector: 'app-logs-page',
  imports: [HlmAlertImports, HlmButton, HlmSkeleton, LogView, NgIcon, RouterLink, TranslatePipe],
  providers: [LogStream, provideIcons({ lucideArrowLeft })],
  host: {
    // The viewport minus the top bar (3.5rem) and the page padding (1rem / 1.5rem each side).
    class: 'flex h-[calc(100dvh-5.5rem)] min-h-96 flex-col gap-3 md:h-[calc(100dvh-6.5rem)]',
  },
  templateUrl: './logs-page.html',
})
export class LogsPage {
  protected readonly logs = inject(LogStream);
  protected readonly name = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('name') ?? '')),
    { requireSync: true },
  );
  private readonly validName = computed(() => containerNameSchema.safeParse(this.name()).success);

  /** What the main area shows; `none` when the notice says it all. */
  protected readonly view = computed(() => {
    const { status } = this.logs.state();
    if (this.logs.entries().length > 0) return 'lines';
    if (status === 'loading') return 'loading';
    if (status === 'live') return 'empty';
    return 'none';
  });

  protected readonly notice = computed<Notice | null>(() => {
    if (!this.validName()) return endNotice('not_found', this.name());
    const state = this.logs.state();
    if (state.status === 'ended') return endNotice(state.reason, this.name());
    if (state.status === 'refused') {
      return { key: 'logs.notice.refused', problem: true, retry: true };
    }
    return null;
  });

  constructor() {
    // Opens the stream for the container in the URL — again when the URL changes to another one.
    effect(() => {
      const name = this.name();
      const valid = this.validName();
      untracked(() => (valid ? this.logs.open(name) : this.logs.close()));
    });
  }

  protected openLogs(): void {
    this.logs.open(this.name());
  }
}

function endNotice(reason: LogsEndReason, name: string): Notice {
  switch (reason) {
    case 'stopped':
      return { key: 'logs.notice.stopped', problem: false, retry: true };
    case 'removed':
      return { key: 'logs.notice.removed', problem: false, retry: false };
    case 'not_found':
      return { key: 'logs.notice.notFound', params: { name }, problem: true, retry: false };
    case 'unavailable':
      return { key: 'logs.notice.unavailable', problem: false, retry: false };
    case 'error':
      return { key: 'logs.notice.error', problem: true, retry: true };
  }
}
