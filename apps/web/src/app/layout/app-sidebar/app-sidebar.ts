import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmSidebarImports } from '@ui/sidebar';
import { UpdatesStore } from '../../core/updates/updates-store';
import { AlertsStore } from '../../core/alerts/alerts-store';
import { BackupsStore } from '../../core/backups/backups-store';
import { LanguageService } from '../../core/i18n/language';
import { APP_NAME } from '../../core/page-title/page-title';
import { LarisMark } from '../../shared/brand/laris-mark';
import { NAV_ICONS, NAVIGATION } from '../navigation';

/**
 * The app's navigation. Collapses to icons (with tooltips) on medium screens and when toggled;
 * a slide-out sheet on phones, closed again when a page is chosen.
 */
@Component({
  selector: 'laris-sidebar',
  imports: [HlmSidebarImports, LarisMark, NgIcon, RouterLink, RouterLinkActive, TranslatePipe],
  providers: [provideIcons(NAV_ICONS)],
  templateUrl: './app-sidebar.html',
})
export class AppSidebar {
  protected readonly appName = APP_NAME;
  protected readonly navigation = NAVIGATION;
  /** Right to left: the sidebar sits on the right, its tooltips open to the left. */
  private readonly languageService = inject(LanguageService);
  protected readonly rtl = computed(() => this.languageService.dir() === 'rtl');
  private readonly backups = inject(BackupsStore);
  private readonly alerts = inject(AlertsStore);
  private readonly updatesStore = inject(UpdatesStore);
  /** Parts of the app that need attention: a badge beside their entry. */
  protected readonly attention = computed(() => ({
    backups: this.backups.warnings().length,
    alerts: this.alerts.open().length,
    updates: this.updatesStore.available() ? 1 : 0,
  }));
}
