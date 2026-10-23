import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMailWarning } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { AlertCard } from '../alert-card/alert-card';
import { AlertsPageStore } from './alerts-page-store';
import { EmptyState } from '../../../shared/empty-state/empty-state';

/**
 * The Alerts page (docs/plans/health_alerts.md): open alerts first (each can be acknowledged),
 * then those resolved in the last 7 days; a notice when a message couldn't be sent.
 */
@Component({
  selector: 'laris-alerts-page',
  imports: [
    EmptyState,
    AlertCard,
    HlmAlertImports,
    HlmButton,
    HlmSkeleton,
    NgIcon,
    RouterLink,
    TranslatePipe,
  ],
  providers: [AlertsPageStore, provideIcons({ lucideMailWarning })],
  templateUrl: './alerts-page.html',
})
export class AlertsPage {
  protected readonly alertsPageStore = inject(AlertsPageStore);
  protected readonly alertsStore = inject(AlertsStore);
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);

  /** "The last message by email couldn't be sent (17 Oct, 14:02). The server refused the login." */
  protected readonly deliveryText = computed(() => {
    const failure = this.alertsStore.deliveryFailure();
    if (!failure) return null;
    return this.translator.t('alerts.delivery.text', {
      channel: this.translator.t(`alerts.channel.${failure.channel}`),
      time: this.formatter.dateTime(failure.at),
      problem: this.translator.t(`alerts.problem.${failure.problem}`),
    });
  });
}
