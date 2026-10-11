import { Component, computed, input } from '@angular/core';
import type { SystemSample } from '@homelab/shared';
import { HlmCardImports } from '@ui/card';
import { HlmProgressImports } from '@ui/progress';
import { formatBytes, formatPercent, percentOf } from '../../../shared/format/format';

@Component({
  selector: 'app-memory-card',
  imports: [HlmCardImports, HlmProgressImports],
  template: `
    <section hlmCard class="h-full" aria-labelledby="memory-title">
      <div hlmCardHeader>
        <h2 hlmCardTitle id="memory-title">Memory</h2>
        <p hlmCardDescription>{{ total() }} total</p>
      </div>
      <div hlmCardContent class="grid gap-3">
        <p class="text-3xl font-semibold tabular-nums">{{ usedPercent() }}</p>
        <hlm-progress [value]="usedValue()" aria-label="Memory in use">
          <hlm-progress-indicator />
        </hlm-progress>
        <p class="text-sm text-muted-foreground">{{ used() }} in use</p>
        <p class="text-sm text-muted-foreground">{{ swap() }}</p>
      </div>
    </section>
  `,
})
export class MemoryCard {
  readonly memory = input.required<SystemSample['memory']>();

  protected readonly usedValue = computed(() =>
    percentOf(this.memory().usedBytes, this.memory().totalBytes),
  );
  protected readonly usedPercent = computed(() => formatPercent(this.usedValue()));
  protected readonly used = computed(() => formatBytes(this.memory().usedBytes));
  protected readonly total = computed(() => formatBytes(this.memory().totalBytes));
  protected readonly swap = computed(() => {
    const { swapTotalBytes, swapUsedBytes } = this.memory();
    if (swapTotalBytes === 0) return 'No swap';
    return `Swap: ${formatBytes(swapUsedBytes)} of ${formatBytes(swapTotalBytes)}`;
  });
}
