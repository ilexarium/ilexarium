import { Component, computed, inject } from '@angular/core';
import {
  type ConnectionStatus as Status,
  RealtimeService,
} from '../../core/realtime/realtime-service';

const LABELS: Record<Status, string> = {
  offline: 'Offline',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
};

/**
 * Whether live data is flowing: a dot plus a label (the label is hidden on phones, but stays
 * for screen readers, which hear changes through `role="status"`).
 */
@Component({
  selector: 'app-connection-status',
  host: {
    role: 'status',
    class: 'flex items-center gap-2 text-sm text-muted-foreground',
    '[attr.data-status]': 'status()',
  },
  template: `
    <span
      aria-hidden="true"
      class="size-2 rounded-full"
      [class]="
        status() === 'live'
          ? 'bg-emerald-500'
          : status() === 'offline'
            ? 'bg-muted-foreground'
            : 'animate-pulse bg-amber-500'
      "
    ></span>
    <span class="max-sm:sr-only">{{ label() }}</span>
  `,
})
export class ConnectionStatus {
  protected readonly status = inject(RealtimeService).status;
  protected readonly label = computed(() => LABELS[this.status()]);
}
