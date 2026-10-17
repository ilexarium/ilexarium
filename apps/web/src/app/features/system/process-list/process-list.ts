import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Process } from '@homelab/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButton } from '@ui/button';
import { HlmTableImports } from '@ui/table';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { processKey } from '../processes-page/processes-page-store';
import type { EndRequest } from '../processes.model';

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

/**
 * The processes as a table from extra-large screens up, one card each below (nothing scrolls
 * sideways on phones). Presentational: the rows in, "end" and "force" out (the page confirms).
 */
@Component({
  selector: 'app-process-list',
  imports: [
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

  protected busy(row: Row): boolean {
    return this.pending().includes(row.key);
  }
}
