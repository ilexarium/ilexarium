import { Component, computed, inject } from '@angular/core';
import { Translator } from '../../core/i18n/translator';
import { RealtimeService } from '../../core/realtime/realtime-service';

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
  templateUrl: './connection-status.html',
})
export class ConnectionStatus {
  protected readonly status = inject(RealtimeService).status;
  private readonly translator = inject(Translator);
  protected readonly label = computed(() => this.translator.t(`connection.${this.status()}`));
}
