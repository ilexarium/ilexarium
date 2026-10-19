import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LANGUAGE_NAMES } from '@homelab/i18n';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAvatarImports } from '@ui/avatar';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmSeparator } from '@ui/separator';
import { HlmSidebarTrigger } from '@ui/sidebar';
import { AlertsStore } from '../../core/alerts/alerts-store';
import { AuthStore } from '../../core/auth/auth-store';
import { LanguageService } from '../../core/i18n/language';
import { PageTitleStrategy } from '../../core/page-title/page-title';
import { AlertsMenu } from '../alerts-menu/alerts-menu';
import { ConnectionStatus } from '../connection-status/connection-status';
import { ThemeMenu } from '../theme-menu/theme-menu';

/**
 * Sidebar toggle, the page title (the page's only h1), the live-data status, the alerts' bell
 * (open alerts on it, a dropdown of the alerts), the theme switch and the user menu (language, change
 * password, sign out).
 */
@Component({
  selector: 'app-top-bar',
  imports: [
    AlertsMenu,
    RouterLink,
    HlmAvatarImports,
    HlmButton,
    HlmDropdownMenuImports,
    HlmSeparator,
    HlmSidebarTrigger,
    ConnectionStatus,
    ThemeMenu,
    TranslatePipe,
  ],
  host: {
    class: 'sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4',
  },
  templateUrl: './top-bar.html',
})
export class TopBar {
  protected readonly auth = inject(AuthStore);
  protected readonly alerts = inject(AlertsStore);
  protected readonly languages = inject(LanguageService);
  /** Each language in itself — the same in every interface language. */
  protected readonly names = LANGUAGE_NAMES;
  protected readonly pageTitle = inject(PageTitleStrategy).pageTitle;
  protected readonly initials = computed(() =>
    (this.auth.user()?.username ?? '?').slice(0, 2).toUpperCase(),
  );
}
