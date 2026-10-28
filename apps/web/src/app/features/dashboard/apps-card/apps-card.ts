import { Component, computed, DOCUMENT, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catalogIconPath } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideExternalLink,
  lucideLoaderCircle,
  lucidePlay,
  lucideBox,
  lucideSparkles,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { LIGHT_CLASSES } from '../dashboard.constants';
import type { AppTile, Light } from '../dashboard.model';

/** Your apps: each with its state and its way in (Open, or Start when stopped). */
@Component({
  selector: 'laris-apps-card',
  imports: [HlmButton, HlmCardImports, HlmSkeleton, NgIcon, PluralPipe, RouterLink, TranslatePipe],
  providers: [
    provideIcons({
      lucideChevronRight,
      lucideExternalLink,
      lucideLoaderCircle,
      lucidePlay,
      lucideBox,
      lucideSparkles,
    }),
  ],
  host: { class: 'block' },
  templateUrl: './apps-card.html',
})
export class AppsCard {
  readonly apps = input.required<AppTile[]>();
  /** False until the containers' first snapshot. */
  readonly loaded = input.required<boolean>();
  readonly otherContainers = input.required<number>();
  readonly start = output<AppTile>();

  private readonly location = inject(DOCUMENT).location;
  protected readonly lightClasses = LIGHT_CLASSES;

  protected readonly rows = computed(() =>
    this.apps().map((app) => ({
      app,
      iconUrl: app.app.template ? catalogIconPath(app.app.template.id) : null,
      openUrl:
        app.app.webPort !== null ? `http://${this.location.hostname}:${app.app.webPort}/` : null,
      state: appState(app),
      canStart:
        (app.app.state === 'stopped' || app.app.state === 'partial') && app.stopped.length > 0,
    })),
  );
}

/** An app's state, in a word and a light. */
function appState({ app }: AppTile): { key: string; light: Light } {
  const light: Record<AppTile['app']['state'], Light> = {
    running: 'ok',
    partial: 'warn',
    unhealthy: 'fail',
    stopped: 'idle',
    none: 'idle',
  };
  return { key: `apps.state.${app.state}`, light: light[app.state] };
}
