import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Alert } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleAlert, lucideCircleCheck, lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { alertIcon, alertLink, alertText, alertTitle } from '../../../core/alerts/alert-wording';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { SEVERITY_TONES } from '../alerts.constants';

/** One alert: what happened, since when, where to look; an open one can be acknowledged. */
@Component({
  selector: 'app-alert-card',
  imports: [StatusBadge, HlmButton, NgIcon, RouterLink, TranslatePipe],
  providers: [provideIcons({ lucideCircleAlert, lucideCircleCheck, lucideTriangleAlert })],
  host: { class: 'block' },
  templateUrl: './alert-card.html',
})
export class AlertCard {
  protected readonly severityTones = SEVERITY_TONES;
  readonly alert = input.required<Alert>();
  /** Being acknowledged. */
  readonly pending = input(false);
  readonly acknowledge = output<string>();

  protected readonly format = inject(Formatter);
  protected readonly title = computed(() => alertTitle(this.alert(), this.format));
  protected readonly text = computed(() => alertText(this.alert()));
  protected readonly link = computed(() => alertLink(this.alert()));
  protected readonly icon = computed(() => alertIcon(this.alert()));
}
