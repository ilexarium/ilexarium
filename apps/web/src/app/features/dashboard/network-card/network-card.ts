import { Component, computed, input } from '@angular/core';
import type { NetworkInterfaceStats } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowDown, lucideArrowUp } from '@ng-icons/lucide';
import { HlmCardImports } from '@ui/card';
import { formatRate } from '../../../shared/format/format';

@Component({
  selector: 'app-network-card',
  imports: [HlmCardImports, NgIcon],
  providers: [provideIcons({ lucideArrowDown, lucideArrowUp })],
  template: `
    <section hlmCard class="h-full" aria-labelledby="network-title">
      <div hlmCardHeader>
        <h2 hlmCardTitle id="network-title">Network</h2>
        <p hlmCardDescription>All interfaces</p>
      </div>
      <div hlmCardContent class="grid gap-3">
        <p class="flex flex-wrap gap-x-4 gap-y-1 text-2xl font-semibold tabular-nums">
          <span class="flex items-center gap-1">
            <ng-icon name="lucideArrowDown" class="text-base" aria-hidden="true" />
            <span class="sr-only">Receiving </span>{{ total().rx }}
          </span>
          <span class="flex items-center gap-1">
            <ng-icon name="lucideArrowUp" class="text-base" aria-hidden="true" />
            <span class="sr-only">Sending </span>{{ total().tx }}
          </span>
        </p>
        @if (interfaces().length > 1) {
          <ul class="grid gap-1 text-sm text-muted-foreground">
            @for (iface of rows(); track iface.name) {
              <li class="flex flex-wrap justify-between gap-x-3">
                <span class="font-medium">{{ iface.name }}<span class="sr-only">: </span></span>
                <span class="tabular-nums">
                  <span aria-hidden="true">↓ </span><span class="sr-only">receiving </span
                  >{{ iface.rx }}<span class="sr-only">, </span><span aria-hidden="true"> ↑ </span
                  ><span class="sr-only">sending </span>{{ iface.tx }}
                </span>
              </li>
            }
          </ul>
        } @else if (interfaces().length === 0) {
          <p class="text-sm text-muted-foreground">No network interfaces found.</p>
        }
      </div>
    </section>
  `,
})
export class NetworkCard {
  readonly interfaces = input.required<NetworkInterfaceStats[]>();

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
