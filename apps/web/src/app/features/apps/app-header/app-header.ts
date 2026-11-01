import { Component, computed, input, output } from '@angular/core';
import type { AppState } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBox,
  lucideEllipsis,
  lucideExternalLink,
  lucidePlay,
  lucideSquare,
  lucideTrash2,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import { shortFolder } from '../app-stats';
import { APP_STATE_DOTS } from '../apps.constants';

/**
 * An app's band at the top of its page (and while it installs): icon, name, template, its state; Open, Start or Stop and "⋯" (Remove) at the end; whose, where and its containers below.
 */
@Component({
  selector: 'laris-app-header',
  imports: [HlmButton, HlmDropdownMenuImports, NgIcon, PluralPipe, StatusDot, TranslatePipe],
  providers: [
    provideIcons({
      lucideBox,
      lucideEllipsis,
      lucideExternalLink,
      lucidePlay,
      lucideSquare,
      lucideTrash2,
    }),
  ],
  host: { class: 'block' },
  templateUrl: './app-header.html',
})
export class AppHeader {
  readonly name = input.required<string>();
  readonly iconUrl = input<string | null>(null);
  readonly templateName = input<string | null>(null);
  /** Null: not known yet (no dot). */
  readonly state = input<AppState | null>(null);
  /** Being installed: says so, without actions. */
  readonly installing = input(false);
  /** Open, Start or Stop, and the menu (none while adding the app). */
  readonly actions = input(true);
  readonly owner = input<string | null>(null);
  readonly folder = input<string | null>(null);
  readonly containers = input(0);
  readonly openUrl = input<string | null>(null);
  /** A start or stop is under way. */
  readonly pending = input(false);
  /** A task runs, or a change is being made: no removal meanwhile. */
  readonly busy = input(false);
  readonly start = output<void>();
  readonly stop = output<void>();
  readonly remove = output<void>();

  protected readonly dots = APP_STATE_DOTS;
  protected readonly shownFolder = computed(() => {
    const folder = this.folder();
    return folder ? shortFolder(folder, this.owner()) : null;
  });
  protected readonly canStart = computed(() => {
    const state = this.state();
    return state === 'stopped' || state === 'partial';
  });
  protected readonly canStop = computed(() => {
    const state = this.state();
    return state === 'running' || state === 'partial' || state === 'unhealthy';
  });
}
