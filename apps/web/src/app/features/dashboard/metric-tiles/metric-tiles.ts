import { Component, computed, inject, input } from '@angular/core';
import type { SystemSnapshot } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowUp,
  lucideCpu,
  lucideMemoryStick,
  lucideNetwork,
  lucideThermometer,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { Sparkline } from '../../../shared/charts/sparkline/sparkline';
import { Formatter } from '../../../shared/format/formatter';
import { percentOf } from '../../../shared/format/format';
import { CPU_WORDS, TEMPERATURE_WORDS } from '../dashboard.constants';
import type { Text } from '../dashboard.model';
import { TextPipe } from '../text-pipe';
import { TONE_CLASSES } from './metric-tiles.constants';
import type { Tone } from './metric-tiles.model';

/** CPU, memory, network and temperature: each a value, a word and its recent line. */
@Component({
  selector: 'laris-metric-tiles',
  imports: [NgIcon, Sparkline, TextPipe, TranslatePipe],
  providers: [
    provideIcons({
      lucideArrowDown,
      lucideArrowUp,
      lucideCpu,
      lucideMemoryStick,
      lucideNetwork,
      lucideThermometer,
    }),
  ],
  host: { class: 'grid h-full grid-cols-2 gap-2.5' },
  templateUrl: './metric-tiles.html',
})
export class MetricTiles {
  readonly system = input.required<SystemSnapshot>();
  private readonly formatter = inject(Formatter);
  protected readonly toneClasses = TONE_CLASSES;

  private readonly sample = computed(() => this.system().sample);
  private readonly history = computed(() => this.system().history);

  protected readonly cpu = computed(() => {
    const { usagePercent, loadAverage } = this.sample().cpu;
    const word =
      usagePercent < CPU_WORDS.quiet
        ? 'quiet'
        : usagePercent < CPU_WORDS.busy
          ? 'busy'
          : 'veryBusy';
    return {
      value: this.formatter.percent(usagePercent),
      word: { key: `dashboard.tiles.cpu.${word}` } satisfies Text,
      tone: (word === 'veryBusy' ? 'warn' : 'neutral') as Tone,
      load: loadAverage.map((value) => this.formatter.decimal(value)).join(' · '),
      series: [{ values: this.history().map((p) => p.cpuPercent), color: 'var(--chart-1)' }],
    };
  });

  protected readonly memory = computed(() => {
    const { usedBytes, totalBytes } = this.sample().memory;
    return {
      value: this.formatter.bytes(usedBytes),
      word: this.formatter.percent(percentOf(usedBytes, totalBytes)),
      total: this.formatter.bytes(totalBytes),
      max: totalBytes,
      series: [{ values: this.history().map((p) => p.memoryUsedBytes), color: 'var(--chart-5)' }],
    };
  });

  protected readonly network = computed(() => {
    let rx = 0;
    let tx = 0;
    for (const iface of this.sample().network) {
      rx += iface.rxBytesPerSec;
      tx += iface.txBytesPerSec;
    }
    return {
      rx: this.formatter.rate(rx),
      tx: this.formatter.rate(tx),
      series: [
        { values: this.history().map((p) => p.rxBytesPerSec), color: 'var(--chart-4)' },
        { values: this.history().map((p) => p.txBytesPerSec), color: 'var(--chart-2)' },
      ],
    };
  });

  /** Null without a sensor (most VMs): the tile is left out, and Network takes its place. */
  protected readonly temperature = computed(() => {
    const reading = this.sample().temperature;
    if (!reading) return null;
    const { celsius, criticalCelsius } = reading;
    const limit = (fixed: number, below: number) =>
      criticalCelsius === null ? fixed : Math.min(fixed, criticalCelsius - below);
    const word =
      celsius >= limit(TEMPERATURE_WORDS.hot, TEMPERATURE_WORDS.hotBelowCritical)
        ? 'hot'
        : celsius >= limit(TEMPERATURE_WORDS.warm, TEMPERATURE_WORDS.warmBelowCritical)
          ? 'warm'
          : 'normal';
    return {
      value: this.formatter.celsius(celsius),
      word: { key: `dashboard.tiles.temperature.${word}` } satisfies Text,
      tone: ({ normal: 'ok', warm: 'warn', hot: 'fail' } as const)[word],
      max: Math.max(criticalCelsius ?? 0, 90),
      series: [
        {
          values: this.history()
            .map((p) => p.temperatureC)
            .filter((c) => c !== null),
          color: 'var(--chart-3)',
        },
      ],
    };
  });
}
