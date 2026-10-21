import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { type Process, processKey } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButton } from '@ui/button';
import { HlmTableImports } from '@ui/table';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import type { EndRequest } from '../processes.model';
import { EmptyState } from '../../../shared/empty-state/empty-state';

interface Row {
  key: string;
  process: Process;
  user: string;
  cpu: string;
  memory: string;
  memoryShare: string;
  started: string;
  container: string | null;
  action: 'end' | 'force' | 'containers' | null;
}

/** Where the table starts (Tailwind's `xl`): below it, cards. */
const WIDE = '(min-width: 1280px)';

/**
 * The processes as a table from extra-large screens up, one card each below (nothing scrolls
 * sideways on phones) — only the one that fits is rendered, the list updates every 2 s.
 * Presentational: the rows in, "end" and "force" out (the page confirms).
 */
@Component({
  selector: 'laris-process-list',
  imports: [
    EmptyState,
    HlmBadgeImports,
    HlmButton,
    HlmTableImports,
    NgTemplateOutlet,
    RouterLink,
    TranslatePipe,
  ],
  templateUrl: './process-list.html',
})
export class ProcessList {
  readonly processes = input.required<Process[]>();
  /** Keys of processes being signalled. */
  readonly pending = input<string[]>([]);
  /** Keys of processes that ignored being asked to stop: offered "Force end". */
  readonly forceable = input<string[]>([]);
  /** When the list was read (for "started 3 hours ago"). */
  readonly now = input.required<number>();
  readonly end = output<EndRequest>();

  private readonly format = inject(Formatter);
  /** Wide enough for the table (without `matchMedia`, as in tests: yes). */
  protected readonly wide = signal(true);
  private readonly translator = inject(Translator);

  protected readonly rows = computed<Row[]>(() => {
    const forceable = new Set(this.forceable());
    return this.processes().map((process) => {
      const key = processKey(process);
      const container = process.container;
      return {
        key,
        process,
        user: process.user ?? this.translator.t('processes.unknownUser', { uid: process.uid }),
        cpu: this.format.percent(process.cpuPercent),
        memory: this.format.bytes(process.memoryBytes),
        memoryShare: this.format.percent(process.memoryPercent),
        started: process.startedAt
          ? this.translator.t('processes.startedAgo', {
              duration: this.format.ago(process.startedAt, this.now()),
            })
          : '—',
        container: container
          ? container.name
            ? this.translator.t('processes.container', { name: container.name })
            : this.translator.t('processes.unknownContainer')
          : null,
        action: process.endable
          ? forceable.has(key)
            ? 'force'
            : 'end'
          : container
            ? 'containers'
            : null,
      };
    });
  });

  constructor() {
    const media = inject(DOCUMENT).defaultView?.matchMedia?.(WIDE);
    if (media) {
      this.wide.set(media.matches);
      const changed = (event: MediaQueryListEvent) => this.wide.set(event.matches);
      media.addEventListener('change', changed);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', changed));
    }
  }

  protected busy(row: Row): boolean {
    return this.pending().includes(row.key);
  }
}
