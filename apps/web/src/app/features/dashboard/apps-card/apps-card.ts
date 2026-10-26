import { Component, computed, DOCUMENT, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catalogIconPath } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideExternalLink,
  lucideLoaderCircle,
  lucidePlay,
  lucideSparkles,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { serviceUrl } from '../../../core/services/service-runtimes';
import { LIGHT_CLASSES } from '../dashboard.constants';
import type { AppTile, Light } from '../dashboard.model';

/** Your apps: each installed service with its state and its way in (Open, or Start when stopped). */
@Component({
  selector: 'laris-apps-card',
  imports: [HlmButton, HlmCardImports, HlmSkeleton, NgIcon, PluralPipe, RouterLink, TranslatePipe],
  providers: [
    provideIcons({
      lucideChevronRight,
      lucideExternalLink,
      lucideLoaderCircle,
      lucidePlay,
      lucideSparkles,
    }),
  ],
  host: { class: 'block' },
  templateUrl: './apps-card.html',
})
export class AppsCard {
  readonly apps = input.required<AppTile[]>();
  /** False until the services' first snapshot. */
  readonly loaded = input.required<boolean>();
  readonly otherContainers = input.required<number>();
  readonly start = output<AppTile>();

  private readonly location = inject(DOCUMENT).location;
  protected readonly lightClasses = LIGHT_CLASSES;

  protected readonly rows = computed(() =>
    this.apps().map((app) => ({
      app,
      iconUrl: catalogIconPath(app.service.catalogId),
      openUrl: serviceUrl(app.service, this.location.hostname),
      state: appState(app),
      canStart:
        app.service.status === 'installed' &&
        (app.runtime === 'stopped' || app.runtime === 'partial') &&
        app.stopped.length > 0,
    })),
  );
}

/** An app's state, in a word and a light. */
function appState(app: AppTile): { key: string; light: Light } {
  const { status } = app.service;
  if (status === 'failed') return { key: 'dashboard.apps.state.failed', light: 'fail' };
  if (status !== 'installed') return { key: `services.status.${status}`, light: 'busy' };
  switch (app.runtime) {
    case 'running':
      return { key: 'services.runtime.running', light: 'ok' };
    case 'partial':
      return { key: 'services.runtime.partial', light: 'warn' };
    case 'unhealthy':
      return { key: 'services.runtime.unhealthy', light: 'fail' };
    case 'stopped':
      return { key: 'services.runtime.stopped', light: 'idle' };
    default:
      return { key: 'services.status.installed', light: 'idle' };
  }
}
