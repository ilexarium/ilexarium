import { Component, computed, inject, input } from '@angular/core';
import type { HostInfo } from '@homelab/shared';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';

/** One line about the machine: name, OS, kernel, CPU, uptime. */
@Component({
  selector: 'app-host-summary',
  host: { class: 'block text-sm text-muted-foreground' },
  templateUrl: './host-summary.html',
})
export class HostSummary {
  readonly host = input.required<HostInfo>();
  readonly uptimeSeconds = input.required<number>();
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  protected readonly details = computed(() => {
    const { os, kernel, arch, cpuModel } = this.host();
    return [
      os,
      `Linux ${kernel}`,
      cpuModel ? `${cpuModel} (${arch})` : arch,
      this.translator.t('dashboard.host.up', {
        duration: this.formatter.duration(this.uptimeSeconds()),
      }),
    ].join(' · ');
  });
}
