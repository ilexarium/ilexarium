import { Component, computed, input } from '@angular/core';
import type { NetworkInterfaceStats, SystemHistoryPoint } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDown, lucideArrowUp } from '@ng-icons/lucide';
import { HlmCardImports } from '@ui/card';
import { type ChartSeries, MetricChart } from '../../../shared/charts/metric-chart';
import { formatRate } from '../../../shared/format/format';

@Component({
  selector: 'app-network-card',
  imports: [HlmCardImports, MetricChart, NgIcon],
  providers: [provideIcons({ lucideArrowDown, lucideArrowUp })],
  templateUrl: './network-card.html',
})
export class NetworkCard {
  readonly interfaces = input.required<NetworkInterfaceStats[]>();
  readonly history = input.required<SystemHistoryPoint[]>();

  protected readonly chart = computed<ChartSeries[]>(() => [
    { name: 'Receiving', points: this.history().map((p) => [p.at, p.rxBytesPerSec]) },
    { name: 'Sending', points: this.history().map((p) => [p.at, p.txBytesPerSec]) },
  ]);

  protected readonly total = computed(() => {
    let rx = 0;
    let tx = 0;
    for (const iface of this.interfaces()) {
      rx += iface.rxBytesPerSec;
      tx += iface.txBytesPerSec;
    }
    return { rx: formatRate(rx), tx: formatRate(tx) };
  });
  protected readonly rows = computed(() =>
    this.interfaces().map((iface) => ({
      name: iface.name,
      rx: formatRate(iface.rxBytesPerSec),
      tx: formatRate(iface.txBytesPerSec),
    })),
  );
}
