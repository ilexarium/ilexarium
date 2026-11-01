import { Component, computed, DOCUMENT, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  type AppSummary,
  type BackupsStatus,
  catalogIconPath,
  type TemplateSummary,
} from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBox, lucideExternalLink, lucidePlay, lucideSquare } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { Sparkline } from '../../../shared/charts/sparkline/sparkline';
import { Formatter } from '../../../shared/format/formatter';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import { appTrends, shortFolder } from '../app-stats';
import { APP_STATE_DOTS } from '../apps.constants';
import type { AppStats } from '../apps.model';

/** One app: its state, CPU and memory, its last backup, whose and where, Open, Start or Stop. */
@Component({
  selector: 'laris-app-card',
  imports: [HlmButton, NgIcon, RouterLink, Sparkline, StatusDot, TranslatePipe],
  providers: [provideIcons({ lucideBox, lucideExternalLink, lucidePlay, lucideSquare })],
  host: { class: 'block' },
  templateUrl: './app-card.html',
})
export class AppCard {
  readonly app = input.required<AppSummary>();
  readonly template = input<TemplateSummary | null>(null);
  /** A start or stop is under way. */
  readonly pending = input(false);
  /** Summed over its containers; null while none runs. */
  readonly stats = input<AppStats | null>(null);
  /** Its backup item; null: not in the backups. */
  readonly backup = input<BackupsStatus['items'][number] | null>(null);
  readonly start = output<void>();
  readonly stop = output<void>();

  private readonly location = inject(DOCUMENT).location;
  protected readonly formatter = inject(Formatter);
  protected readonly dots = APP_STATE_DOTS;
  protected readonly iconUrl = computed(() => {
    const id = this.app().template?.id;
    return id && this.template() ? catalogIconPath(id) : null;
  });
  /** Its web page: this machine's name, its port. Plain HTTP (inside your network). */
  protected readonly openUrl = computed(() => {
    const port = this.app().webPort;
    return port !== null && this.app().state !== 'none'
      ? `http://${this.location.hostname}:${port}/`
      : null;
  });
  protected readonly query = computed(() =>
    this.app().folder ? { folder: this.app().folder } : {},
  );
  protected readonly folder = computed(() => {
    const { folder, owner } = this.app();
    return folder ? shortFolder(folder, owner) : null;
  });
  protected readonly trends = computed(() => appTrends(this.stats()));
  protected readonly backedUp = computed(() => {
    const at = this.backup()?.lastSuccessAt;
    return at ? this.formatter.ago(at) : null;
  });
}
