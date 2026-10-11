import { Component, computed, input } from '@angular/core';
import type { HostInfo } from '@homelab/shared';
import { formatDuration } from '../../../shared/format/format';

/** One line about the machine: name, OS, kernel, CPU, uptime. */
@Component({
  selector: 'app-host-summary',
  host: { class: 'block text-sm text-muted-foreground' },
  templateUrl: './host-summary.html',
})
export class HostSummary {
  readonly host = input.required<HostInfo>();
  readonly uptimeSeconds = input.required<number>();

  protected readonly details = computed(() => {
    const { os, kernel, arch, cpuModel } = this.host();
    return [
      os,
      `Linux ${kernel}`,
      cpuModel ? `${cpuModel} (${arch})` : arch,
      `up ${formatDuration(this.uptimeSeconds())}`,
    ].join(' · ');
  });
}
