import { Component, computed, inject, input } from '@angular/core';
import type { ActivityItem } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucideCircleCheck,
  lucideCircleX,
  lucideHardDrive,
  lucideHistory,
  lucidePackageMinus,
  lucidePackagePlus,
  lucideRefreshCw,
  lucidePlay,
  lucideRotateCcw,
  lucideShieldCheck,
  lucideSquare,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { alertTitle } from '../../../core/alerts/alert-wording';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import { ACTION_WORDS, ACTIVITY_TONE_CLASSES } from './activity-card.constants';

type Tone = keyof typeof ACTIVITY_TONE_CLASSES;

/** What happened lately — what people did, backups, alerts — newest first, in plain words. */
@Component({
  selector: 'laris-activity-card',
  imports: [HlmCardImports, HlmSkeleton, NgIcon, TranslatePipe],
  providers: [
    provideIcons({
      lucideCircleAlert,
      lucideCircleCheck,
      lucideCircleX,
      lucideHardDrive,
      lucideHistory,
      lucidePackageMinus,
      lucidePackagePlus,
      lucideRefreshCw,
      lucidePlay,
      lucideRotateCcw,
      lucideShieldCheck,
      lucideSquare,
      lucideTriangleAlert,
    }),
  ],
  host: { class: 'block' },
  templateUrl: './activity-card.html',
})
export class ActivityCard {
  /** Null until loaded. */
  readonly items = input.required<ActivityItem[] | null>();
  /** The page's clock: "3 minutes ago" moves on. */
  readonly now = input.required<number>();
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);
  protected readonly toneClasses = ACTIVITY_TONE_CLASSES;

  protected readonly rows = computed(() =>
    (this.items() ?? []).map((item) => ({ id: item.id, ...this.describe(item) })),
  );

  private describe(item: ActivityItem): { text: string; sub: string; icon: string; tone: Tone } {
    const when = this.translator.t('dashboard.ago', {
      time: this.formatter.ago(item.at, this.now()),
    });
    switch (item.source) {
      case 'action': {
        const words = ACTION_WORDS[item.action];
        const subject = item.subject ?? '—';
        return {
          text: this.translator.t(`dashboard.activity.action.${words.key}`, {
            name: words.machine ? this.formatter.machine(subject) : subject,
          }),
          sub: item.username ? `${this.formatter.machine(item.username)} · ${when}` : when,
          icon: words.icon,
          tone: 'neutral',
        };
      }
      case 'backup':
        return {
          text: this.translator.t(`dashboard.activity.backup.${item.status}`),
          sub: `${this.translator.t(`dashboard.activity.trigger.${item.trigger}`)} · ${when}`,
          icon: {
            ok: 'lucideCircleCheck',
            warning: 'lucideTriangleAlert',
            failed: 'lucideCircleX',
          }[item.status],
          tone: ({ ok: 'ok', warning: 'warn', failed: 'fail' } as const)[item.status],
        };
      case 'alert': {
        const title = this.translator.t(...alertTitle(item.alert, this.formatter));
        if (item.event === 'closed') {
          return {
            text: this.translator.t('dashboard.activity.resolved', { what: title }),
            sub: when,
            icon: 'lucideCircleCheck',
            tone: 'ok',
          };
        }
        const critical = item.alert.severity === 'critical';
        return {
          text: title,
          sub: when,
          icon: critical ? 'lucideCircleAlert' : 'lucideTriangleAlert',
          tone: critical ? 'fail' : 'warn',
        };
      }
    }
  }
}
