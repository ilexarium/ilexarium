import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { BackupsStatus } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideShieldCheck } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import type { StatusTone } from '../../../shared/status-badge/status-badge.model';
import type { BackupDay } from '../dashboard.model';
import { DAY_CLASSES } from './backups-card.constants';

/** The backups at a glance: the last and next run, where they go, and the last two weeks. */
@Component({
  selector: 'ilex-backups-card',
  imports: [HlmButton, HlmCardImports, HlmSkeleton, NgIcon, RouterLink, StatusBadge, TranslatePipe],
  providers: [provideIcons({ lucideShieldCheck })],
  host: { class: 'block' },
  templateUrl: './backups-card.html',
})
export class BackupsCard {
  /** Null until the topic's first snapshot. */
  readonly status = input.required<BackupsStatus | null>();
  /** Null until the runs are loaded. */
  readonly days = input.required<BackupDay[] | null>();
  readonly destination = input.required<string | null>();
  /** The page's clock: "3 hours ago" moves on. */
  readonly now = input.required<number>();

  private readonly translator = inject(Translator);
  protected readonly formatter = inject(Formatter);
  protected readonly dayClasses = DAY_CLASSES;

  /** The latest run's outcome, as a badge. */
  protected readonly badge = computed((): { tone: StatusTone; key: string } | null => {
    const status = this.status();
    if (!status?.configured) return null;
    if (status.running) return { tone: 'info', key: 'dashboard.backups.running' };
    switch (status.lastRun?.status) {
      case 'ok':
        return { tone: 'healthy', key: 'dashboard.backups.ok' };
      case 'warning':
        return { tone: 'warning', key: 'dashboard.backups.warning' };
      case 'failed':
        return { tone: 'failed', key: 'dashboard.backups.failed' };
      default:
        return null;
    }
  });

  /** What the strip shows, for screen readers: how many days of each. */
  protected readonly daysLabel = computed(() => {
    const days = this.days() ?? [];
    const count = (outcome: BackupDay['outcome']) =>
      days.filter((d) => d.outcome === outcome).length;
    return this.translator.t('dashboard.backups.daysLabel', {
      days: days.length,
      ok: count('ok'),
      warning: count('warning'),
      failed: count('failed'),
    });
  });
}
