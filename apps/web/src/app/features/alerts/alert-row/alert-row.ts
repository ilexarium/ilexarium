import { Component, computed, inject, input } from '@angular/core';
import type { Alert } from '@ilex/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { alertTitle } from '../../../core/alerts/alert-wording';
import { Formatter } from '../../../shared/format/formatter';
import { StatusDot } from '../../../shared/status-dot/status-dot';

/** A resolved alert, quietly: what it was, how long it lasted, when it ended. */
@Component({
  selector: 'ilex-alert-row',
  imports: [StatusDot, TranslatePipe],
  host: { class: 'block' },
  templateUrl: './alert-row.html',
})
export class AlertRow {
  readonly alert = input.required<Alert>();

  protected readonly formatter = inject(Formatter);
  protected readonly title = computed(() => alertTitle(this.alert(), this.formatter));
  protected readonly lasted = computed(() => {
    const { openedAt, closedAt } = this.alert();
    return closedAt ? this.formatter.ago(openedAt, Date.parse(closedAt)) : '';
  });
}
