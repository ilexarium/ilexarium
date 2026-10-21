import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Alert } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { alertIcon, alertLink, alertTitle } from '../../core/alerts/alert-wording';
import { PluralPipe } from '../../core/i18n/plural-pipe';
import { Formatter } from '../../shared/format/formatter';
import { ALERTS_MENU_ICONS, RESOLVED_IN_MENU } from './alerts-menu.constants';
import type { AlertsMenuRow } from './alerts-menu.model';

/**
 * The alerts' bell: the count of open alerts on it (red when one is critical), and a dropdown of
 * the open alerts, then the recently resolved ones greyed out, each a link to where it belongs
 * (the container's logs, Disks, Backups), and a link to the Alerts page. Presentational: the
 * alerts come in through inputs.
 */
@Component({
  selector: 'laris-alerts-menu',
  imports: [HlmButton, HlmDropdownMenuImports, NgIcon, PluralPipe, RouterLink, TranslatePipe],
  providers: [provideIcons(ALERTS_MENU_ICONS)],
  templateUrl: './alerts-menu.html',
})
export class AlertsMenu {
  /** Critical first, then newest first (as the store has them). */
  readonly open = input.required<Alert[]>();
  /** Resolved in the last 7 days, newest first. */
  readonly resolved = input.required<Alert[]>();

  private readonly format = inject(Formatter);
  /** Bumped when the menu opens, so "… ago" is measured again then (and on every update). */
  private readonly openings = signal(0);

  protected readonly critical = computed(() =>
    this.open().some((alert) => alert.severity === 'critical'),
  );
  /** The open alerts, then the latest resolved ones. */
  protected readonly rows = computed(() => {
    this.openings();
    const now = Date.now();
    return [...this.open(), ...this.resolved().slice(0, RESOLVED_IN_MENU)].map((alert) =>
      this.row(alert, now),
    );
  });
  /** The first resolved row: the "Resolved" heading goes above it. */
  protected readonly firstResolved = computed(() => this.rows().find((row) => row.resolved)?.id);

  protected opened(): void {
    this.openings.update((n) => n + 1);
  }

  private row(alert: Alert, now: number): AlertsMenuRow {
    const { icon, color } = alertIcon(alert);
    return {
      id: alert.id,
      title: alertTitle(alert, this.format),
      when: alert.closedAt
        ? ['alerts.menu.resolvedAgo', { time: this.format.ago(alert.closedAt, now) }]
        : ['alerts.menu.ago', { time: this.format.ago(alert.openedAt, now) }],
      icon,
      iconClass: color,
      link: alertLink(alert).link,
      acknowledged: !alert.closedAt && !!alert.acknowledgedAt,
      resolved: !!alert.closedAt,
    };
  }
}
