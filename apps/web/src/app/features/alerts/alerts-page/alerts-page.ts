import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBellRing, lucideMailWarning } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertImports } from '@ui/alert';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { AlertCard } from '../alert-card/alert-card';
import { AlertRow } from '../alert-row/alert-row';
import { AlertsPageStore } from './alerts-page-store';
import { EmptyState } from '../../../shared/empty-state/empty-state';

/**
 * The Alerts page: a headline with the notification settings beside
 * it, a notice when a message couldn't be sent, the open alerts (each can be acknowledged), then
 * those resolved in the last 7 days as quiet rows.
 */
@Component({
  selector: 'ilex-alerts-page',
  imports: [
    AlertCard,
    AlertRow,
    EmptyState,
    HlmAlertImports,
    HlmButton,
    HlmSkeleton,
    NgIcon,
    PluralPipe,
    RouterLink,
    TranslatePipe,
  ],
  providers: [AlertsPageStore, provideIcons({ lucideBellRing, lucideMailWarning })],
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
