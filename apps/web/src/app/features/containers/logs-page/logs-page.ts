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

interface Notice {
  title: string;
  text: string;
  /** Problems are announced at once (`alert`); the rest politely (`status`). */
  problem: boolean;
  /** Label of a button that opens the stream again, if that can help. */
  retry: string | null;
}

/**
 * One container's logs, live (`/containers/:name/logs`, titled "Logs · <name>"). Fills the screen
 * height below the top bar, so the log box scrolls, not the page. Says in plain words why there
 * are no (more) lines: loading, no output yet, stopped, removed, not found, not readable, Docker
 * not reachable, too many log views.
 */
@Component({
  selector: 'app-logs-page',
  imports: [HlmAlertImports, HlmButton, HlmSkeleton, LogView, NgIcon, RouterLink],
  providers: [LogStream, provideIcons({ lucideArrowLeft })],
  host: {
    // The viewport minus the top bar (3.5rem) and the page padding (1rem / 1.5rem each side).
    class: 'flex h-[calc(100dvh-5.5rem)] min-h-96 flex-col gap-3 md:h-[calc(100dvh-6.5rem)]',
  },
  template: `
    <a hlmBtn variant="ghost" size="sm" routerLink="/containers" class="-ms-2 self-start">
      <ng-icon name="lucideArrowLeft" aria-hidden="true" />
      Containers
    </a>

    @if (notice(); as notice) {
      <div
        hlmAlert
        [variant]="notice.problem ? 'destructive' : 'default'"
        [attr.role]="notice.problem ? 'alert' : 'status'"
      >
        <p hlmAlertTitle>{{ notice.title }}</p>
        <div hlmAlertDescription>
          <p>{{ notice.text }}</p>
          @if (notice.retry) {
            <button hlmBtn variant="outline" size="sm" class="mt-2" (click)="openLogs()">
              {{ notice.retry }}
            </button>
          }
        </div>
      </div>
    }

    @switch (view()) {
      @case ('loading') {
        <div class="grid gap-2" role="status" aria-label="Loading logs">
          <hlm-skeleton class="h-9 w-full" />
          <hlm-skeleton class="h-64 w-full" />
        </div>
      }
      @case ('empty') {
        <div class="rounded-lg border border-dashed p-4 text-sm" role="status">
          <p class="font-medium">No log output yet</p>
          <p class="mt-1 text-muted-foreground">
            New lines appear here as soon as the container writes them.
          </p>
        </div>
      }
      @case ('lines') {
        <app-log-view class="min-h-0 flex-1" [entries]="logs.entries()" />
      }
    }
  `,
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
      return {
        title: 'Too many log views open',
        text: 'This browser tab already shows logs of as many containers as it can at once. Close one, then try again.',
        problem: true,
        retry: 'Try again',
      };
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
      return {
        title: 'Container is stopped',
        text: 'These are its logs up to when it stopped. Start it again to see new output.',
        problem: false,
        retry: 'Follow again',
      };
    case 'removed':
      return {
        title: 'Container was removed',
        text: 'It no longer exists. The lines already loaded stay here until you leave this page.',
        problem: false,
        retry: null,
      };
    case 'not_found':
      return {
        title: 'Container not found',
        text: `There is no container named “${name}”. It may have been removed, or the link is out of date.`,
        problem: true,
        retry: null,
      };
    case 'unavailable':
      return {
        title: 'Logs are not available',
        text: 'This container’s logging setting (its “log driver”, for example none or syslog) keeps no logs that Docker can read back.',
        problem: false,
        retry: null,
      };
    case 'error':
      return {
        title: "Docker isn't reachable",
        text: 'The logs can’t be read right now. Make sure Docker is running, then try again.',
        problem: true,
        retry: 'Try again',
      };
  }
}
