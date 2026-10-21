import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Alert } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { alertTitle } from '../../../core/alerts/alert-wording';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';

/** Alerts shown on the dashboard at most; the rest are counted. */
const SHOWN = 3;

/** The open alerts on the dashboard (backups' warnings among them), with a link to the Alerts page. */
@Component({
  selector: 'laris-alerts-notice',
  imports: [HlmAlertImports, HlmButton, NgIcon, PluralPipe, RouterLink, TranslatePipe],
  providers: [provideIcons({ lucideTriangleAlert })],
  templateUrl: './alerts-notice.html',
})
export class AlertsNotice {
  /** Critical first. */
  readonly alerts = input.required<Alert[]>();

  private readonly format = inject(Formatter);
  protected readonly shown = computed(() =>
    this.alerts()
      .slice(0, SHOWN)
      .map((alert) => ({ id: alert.id, title: alertTitle(alert, this.format) })),
  );
  protected readonly more = computed(() => Math.max(0, this.alerts().length - SHOWN));
  protected readonly critical = computed(() =>
    this.alerts().some((alert) => alert.severity === 'critical'),
  );
}
