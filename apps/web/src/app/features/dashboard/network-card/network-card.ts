import { Component, computed, inject, input } from '@angular/core';
import type { NetworkInterfaceStats, SystemHistoryPoint } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDown, lucideArrowUp } from '@ng-icons/lucide';
import { HlmCardImports } from '@ui/card';
import { MetricChart } from '../../../shared/charts/metric-chart';
import type { ChartSeries } from '../../../shared/charts/charts.model';
import { TranslatePipe } from '@ngx-translate/core';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';

@Component({
  selector: 'laris-network-card',
  imports: [HlmCardImports, MetricChart, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideArrowDown, lucideArrowUp })],
  templateUrl: './network-card.html',
})
export class NetworkCard {
  readonly interfaces = input.required<NetworkInterfaceStats[]>();
  readonly history = input.required<SystemHistoryPoint[]>();
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  protected readonly chart = computed<ChartSeries[]>(() => [
    {
      name: this.translator.t('dashboard.network.receiving'),
      points: this.history().map((p) => [p.at, p.rxBytesPerSec]),
    },
    {
      name: this.translator.t('dashboard.network.sending'),
      points: this.history().map((p) => [p.at, p.txBytesPerSec]),
    },
  ]);

  protected readonly total = computed(() => {
    let rx = 0;
    let tx = 0;
    for (const iface of this.interfaces()) {
      rx += iface.rxBytesPerSec;
      tx += iface.txBytesPerSec;
    }
    return { rx: this.formatter.rate(rx), tx: this.formatter.rate(tx) };
  });
  protected readonly rows = computed(() =>
    this.interfaces().map((iface) => ({
      name: iface.name,
      rx: this.formatter.rate(iface.rxBytesPerSec),
      tx: this.formatter.rate(iface.txBytesPerSec),
    })),
  );
}
