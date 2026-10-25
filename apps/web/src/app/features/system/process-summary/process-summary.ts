import { Component, computed, inject, input, output } from '@angular/core';
import type { ProcessesSummary } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBox, lucideCpu, lucidePackage, lucideServer, lucideUser } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmProgressImports } from '@ui/progress';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import type { LoadLevel, ProcessGroup, ProcessGroupId } from '../processes.model';
import { GROUP_ICONS, PRESSURE_RESOURCES } from './process-summary.constants';

/**
 * The Processes page's header — not htop's meters, but what answers "why is it slow, and who is
 * it": CPU with the load in words, memory and swap, how long processes waited (pressure), where
 * the CPU and memory go (by service, person, system), and anything that needs attention.
 * Presentational: a group or "needs attention" chosen goes out (the page filters by it).
 */
@Component({
  selector: 'laris-process-summary',
  imports: [HlmProgressImports, NgIcon, PluralPipe, TranslatePipe],
  providers: [provideIcons({ lucideBox, lucideCpu, lucidePackage, lucideServer, lucideUser })],
  templateUrl: './process-summary.html',
})
export class ProcessSummary {
  readonly summary = input.required<ProcessesSummary>();
  readonly loadLevel = input.required<LoadLevel>();
  readonly groups = input.required<ProcessGroup[]>();
  readonly attention = input.required<{ zombie: number; waiting: number }>();
  readonly selectedGroup = input<ProcessGroupId | null>(null);
  readonly attentionOn = input(false);
  readonly group = output<ProcessGroupId>();
  readonly toggleAttention = output<void>();

  private readonly formatter = inject(Formatter);
  private readonly translator = inject(Translator);
  protected readonly icons = GROUP_ICONS;
  protected readonly resources = PRESSURE_RESOURCES;

  protected readonly cpu = computed(() => this.formatter.percent(this.summary().cpuPercent));
  protected readonly load = computed(() => this.formatter.decimal(this.summary().load[0]));
  protected readonly memory = computed(() => {
    const { totalBytes, availableBytes, swapTotalBytes, swapUsedBytes } = this.summary().memory;
    const used = Math.max(0, totalBytes - availableBytes);
    return {
      percent: totalBytes > 0 ? (used / totalBytes) * 100 : 0,
      used: this.formatter.bytes(used),
      total: this.formatter.bytes(totalBytes),
      swap: swapTotalBytes > 0,
      swapUsed: this.formatter.bytes(swapUsedBytes),
      swapTotal: this.formatter.bytes(swapTotalBytes),
      // Much of the swap in use: the machine has been short of memory.
      swapHigh: swapTotalBytes > 0 && swapUsedBytes / swapTotalBytes > 0.5,
    };
  });
  protected readonly rows = computed(() =>
    this.groups().map((group) => ({
      group,
      label: this.label(group),
      cpu: this.formatter.percent(group.cpuPercent),
      memory: this.formatter.bytes(group.memoryBytes),
      selected:
        this.selectedGroup()?.kind === group.kind && this.selectedGroup()?.name === group.name,
    })),
  );
  protected readonly attentionCount = computed(
    () => this.attention().zombie + this.attention().waiting,
  );

  protected percent(value: number): string {
    return this.formatter.percent(value);
  }

  private label(group: ProcessGroup): string {
    if (group.kind === 'system') return this.translator.t('processes.summary.system');
    if (group.kind === 'container' && !group.name) {
      return this.translator.t('processes.unknownContainer');
    }
    return group.name;
  }
}
