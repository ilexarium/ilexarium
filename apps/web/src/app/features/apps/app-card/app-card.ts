import { Component, computed, DOCUMENT, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type AppSummary, catalogIconPath, type TemplateSummary } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBox, lucideExternalLink, lucidePlay, lucideSquare } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { APP_STATE_TONES } from '../apps.constants';

/** One app: its state, whose it is and where, Open, and Start or Stop. */
@Component({
  selector: 'laris-app-card',
  imports: [HlmButton, HlmCardImports, NgIcon, RouterLink, StatusBadge, TranslatePipe],
  providers: [provideIcons({ lucideBox, lucideExternalLink, lucidePlay, lucideSquare })],
  host: { class: 'block' },
  templateUrl: './app-card.html',
})
export class AppCard {
  readonly app = input.required<AppSummary>();
  readonly template = input<TemplateSummary | null>(null);
  /** A start or stop is under way. */
  readonly pending = input(false);
  readonly start = output<void>();
  readonly stop = output<void>();

  private readonly location = inject(DOCUMENT).location;
  protected readonly tones = APP_STATE_TONES;
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
}
