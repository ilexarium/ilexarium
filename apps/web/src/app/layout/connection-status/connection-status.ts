import { Component, computed, inject } from '@angular/core';
import { HlmTooltipImports } from '@ui/tooltip';
import { Translator } from '../../core/i18n/translator';
import { MonitoringStore } from '../../core/monitoring/monitoring-store';
import { RealtimeService } from '../../core/realtime/realtime-service';

/**
 * Whether live data is flowing: a dot (beating while live; for people who reduce motion, fading instead)
 * plus a label (hidden on phones, but kept for screen readers, which hear changes through
 * `role="status"`). Hovering the label shows the machine's kernel — extra, also on the dashboard.
 */
@Component({
  selector: 'laris-connection-status',
  host: {
    role: 'status',
    class: 'flex items-center gap-2 text-sm text-muted-foreground',
    '[attr.data-status]': 'status()',
  },
  imports: [HlmTooltipImports],
  templateUrl: './connection-status.html',
})
export class ConnectionStatus {
  protected readonly status = inject(RealtimeService).status;
  private readonly translator = inject(Translator);
  private readonly monitoringStore = inject(MonitoringStore);
  protected readonly label = computed(() => this.translator.t(`connection.${this.status()}`));
  /** The kernel as the server reports it, or empty until the machine's info is known. */
  protected readonly kernel = computed(() => this.monitoringStore.host()?.kernel ?? '');
}
