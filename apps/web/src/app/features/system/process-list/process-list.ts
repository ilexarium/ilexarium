import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { type Process, processKey } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowUp,
  lucideBox,
  lucideEllipsis,
  lucideOctagonX,
  lucideSquare,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { EmptyState } from '../../../shared/empty-state/empty-state';
import type { EndAs, EndRequest, ProcessSort } from '../processes.model';
import {
  COLUMNS,
  HIGH_CPU,
  HIGH_MEMORY,
  PAGE_ROWS,
  STATE_LETTERS,
  WIDE,
} from './process-list.constants';

interface Row {
  key: string;
  process: Process;
  user: string;
  cpu: string;
  memoryShare: string;
  resident: string;
  virtual: string;
  shared: string;
  time: string;
  started: string;
  /** The program's own name (bold) and the rest of its command line (muted). */
  program: string;
  args: string;
  container: string | null;
  /** End and Force end are offered (never PID 1 or a kernel thread). */
  endable: boolean;
  endAs: EndAs;
  cpuHigh: boolean;
  memoryHigh: boolean;
}

/**
 * The processes like htop: a dense table (PID USER PRI NI VIRT RES SHR S CPU% MEM% TIME+
 * Command), sorted by its headers, a selected row and htop's keys — on wide screens; two lines a
 * process on phones and tablets, a tap shows its details and actions. Only the layout that fits
 * is rendered. Presentational: rows in; sorting, ending, search and pause out.
 */
@Component({
  selector: 'laris-process-list',
  imports: [
    EmptyState,
    HlmButton,
    HlmDropdownMenuImports,
    NgIcon,
    NgTemplateOutlet,
    RouterLink,
    TranslatePipe,
  ],
  providers: [
    provideIcons({
      lucideArrowDown,
      lucideArrowUp,
      lucideBox,
      lucideEllipsis,
      lucideOctagonX,
      lucideSquare,
    }),
  ],
  templateUrl: './process-list.html',
})
export class ProcessList {
  readonly processes = input.required<Process[]>();
  readonly sort = input.required<ProcessSort>();
  readonly descending = input.required<boolean>();
  /** How the signed-in account would end each process (its own, or through sudo). */
  readonly endAs = input.required<(process: Process) => EndAs>();
  /** Keys of processes being signalled. */
  readonly pending = input<string[]>([]);
  /** Keys of processes sent TERM that still run. */
  readonly stillRunning = input<string[]>([]);
  /** When the list was read (for "started 3 hours ago"). */
  readonly now = input.required<number>();
  readonly sortBy = output<ProcessSort>();
  readonly end = output<EndRequest>();
  /** htop's `/` and Space, from the table. */
  readonly searchKey = output<void>();
  readonly pauseKey = output<void>();

  private readonly formatter = inject(Formatter);
  private readonly translator = inject(Translator);
  private readonly router = inject(Router);
  private readonly table = viewChild<ElementRef<HTMLElement>>('table');
  /** Wide enough for the table (without `matchMedia`, as in tests: yes). */
  protected readonly wide = signal(true);
  protected readonly columns = COLUMNS;
  protected readonly letters = STATE_LETTERS;
  /** The selected process, by key: it stays selected while the list moves. */
  protected readonly selected = signal<string | null>(null);
  /** Phones: the process whose details are open. */
  protected readonly opened = signal<string | null>(null);

  protected readonly rows = computed<Row[]>(() => {
    const endAs = this.endAs();
    return this.processes().map((process) => {
      const container = process.container;
      const [program = process.name, ...args] = process.command.split(' ');
      return {
        key: processKey(process),
        process,
        user: process.user ?? this.translator.t('processes.unknownUser', { uid: process.uid }),
        cpu: this.formatter.decimal(process.cpuPercent, 1),
        memoryShare: this.formatter.decimal(process.memoryPercent, 1),
        resident: this.formatter.bytes(process.memoryBytes),
        virtual: this.formatter.bytes(process.virtualBytes),
        shared: this.formatter.bytes(process.sharedBytes),
        time: this.formatter.cpuTime(process.cpuSeconds),
        started: process.startedAt
          ? this.translator.t('processes.startedAgo', {
              duration: this.formatter.ago(process.startedAt, this.now()),
            })
          : '—',
        program: process.command ? program : process.name,
        args: args.join(' '),
        container: container
          ? container.name
            ? this.translator.t('processes.container', { name: container.name })
            : this.translator.t('processes.unknownContainer')
          : null,
        endable: process.pid !== 1 && !process.kernel,
        endAs: endAs(process),
        cpuHigh: process.cpuPercent >= HIGH_CPU,
        memoryHigh: process.memoryPercent >= HIGH_MEMORY,
      };
    });
  });

  protected readonly selectedRow = computed(
    () => this.rows().find((row) => row.key === this.selected()) ?? null,
  );

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

  protected still(row: Row): boolean {
    return this.stillRunning().includes(row.key);
  }

  protected ariaSort(column: ProcessSort): 'ascending' | 'descending' | null {
    if (this.sort() !== column) return null;
    return this.descending() ? 'descending' : 'ascending';
  }

  /** A menu item, not a link: the menu handles Enter itself and would cancel a link's navigation. */
  protected toContainers(): void {
    void this.router.navigate(['/containers']);
  }

  protected select(row: Row): void {
    this.selected.set(row.key);
  }

  protected toggleOpened(row: Row): void {
    this.opened.set(this.opened() === row.key ? null : row.key);
  }

  /** htop's keys while the table has focus: move, search, pause, end. */
  protected keydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const rows = this.rows();
    const index = rows.findIndex((row) => row.key === this.selected());
    const moveTo = (next: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (!row) return;
      this.selected.set(row.key);
      this.table()
        ?.nativeElement.querySelector(`[data-key="${row.key}"]`)
        ?.scrollIntoView?.({ block: 'nearest' });
    };
    const row = index >= 0 ? rows[index] : null;
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(index + 1),
      ArrowUp: () => moveTo(index < 0 ? 0 : index - 1),
      PageDown: () => moveTo(index + PAGE_ROWS),
      PageUp: () => moveTo(index - PAGE_ROWS),
      Home: () => moveTo(0),
      End: () => moveTo(rows.length - 1),
      '/': () => this.searchKey.emit(),
      ' ': () => this.pauseKey.emit(),
      k: () => row?.endable && this.end.emit({ process: row.process, signal: 'TERM' }),
      F9: () => row?.endable && this.end.emit({ process: row.process, signal: 'TERM' }),
      K: () => row?.endable && this.end.emit({ process: row.process, signal: 'KILL' }),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }
}
