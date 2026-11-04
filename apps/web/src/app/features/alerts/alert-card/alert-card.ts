import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Alert } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleAlert, lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import {
  alertFreesSpace,
  alertIcon,
  alertLink,
  alertText,
  alertTitle,
} from '../../../core/alerts/alert-wording';
import { Formatter } from '../../../shared/format/formatter';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import { SEVERITY_DOTS } from '../alerts.constants';

/** An open alert: what happened, for how long, where to look; it can be acknowledged. */
@Component({
  selector: 'laris-alert-card',
  imports: [HlmButton, NgIcon, RouterLink, StatusDot, TranslatePipe],
  providers: [provideIcons({ lucideCircleAlert, lucideTriangleAlert })],
  host: { class: 'block' },
  templateUrl: './alert-card.html',
})
export class AlertCard {
  protected readonly severityDots = SEVERITY_DOTS;
  readonly alert = input.required<Alert>();
  /** Being acknowledged. */
  readonly pending = input(false);
  readonly acknowledge = output<string>();

  protected readonly formatter = inject(Formatter);
  protected readonly title = computed(() => alertTitle(this.alert(), this.formatter));
  protected readonly text = computed(() => alertText(this.alert()));
  protected readonly link = computed(() => alertLink(this.alert()));
  protected readonly icon = computed(() => alertIcon(this.alert()));
  protected readonly freesSpace = computed(() => alertFreesSpace(this.alert()));
  /** The container, when the title names its app instead ("Immich has stopped"). */
  protected readonly container = computed(() => {
    const { kind, app, subject } = this.alert();
    return kind !== 'backup' && app ? subject : null;
  });
}
