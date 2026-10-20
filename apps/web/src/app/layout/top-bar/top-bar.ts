import { CdkMenuTrigger } from '@angular/cdk/menu';
import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LANGUAGE_NAMES } from '@homelab/i18n';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideCircleUser,
  lucideGlobe,
  lucideLogOut,
  lucidePencil,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmSeparator } from '@ui/separator';
import { HlmSidebarTrigger } from '@ui/sidebar';
import { AlertsStore } from '../../core/alerts/alerts-store';
import { AuthStore } from '../../core/auth/auth-store';
import { ProfileStore } from '../../core/profile/profile-store';
import { LanguageService } from '../../core/i18n/language';
import { PageTitleStrategy } from '../../core/page-title/page-title';
import { ProfileDialog } from '../../shared/profile-dialog/profile-dialog';
import { displayNameOf, UserAvatar } from '../../shared/user-avatar/user-avatar';
import { AlertsMenu } from '../alerts-menu/alerts-menu';
import { ConnectionStatus } from '../connection-status/connection-status';
import { ThemeMenu } from '../theme-menu/theme-menu';

/**
 * Sidebar toggle, the page title (the page's only h1), the live-data status, the alerts' bell
 * (open alerts on it, a dropdown of the alerts), the theme switch and the user menu (edit profile,
 * the profile page, language, sign out).
 */
@Component({
  selector: 'app-top-bar',
  imports: [
    AlertsMenu,
    ConnectionStatus,
    HlmButton,
    HlmDropdownMenuImports,
    HlmSeparator,
    HlmSidebarTrigger,
    NgIcon,
    ProfileDialog,
    RouterLink,
    ThemeMenu,
    TranslatePipe,
    UserAvatar,
  ],
  providers: [
    provideIcons({
      lucideChevronDown,
      lucideCircleUser,
      lucideGlobe,
      lucideLogOut,
      lucidePencil,
    }),
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
  protected readonly profile = inject(ProfileStore);
  /** Each language in itself — the same in every interface language. */
  protected readonly names = LANGUAGE_NAMES;
  protected readonly pageTitle = inject(PageTitleStrategy).pageTitle;
  protected readonly name = computed(() => displayNameOf(this.auth.user()));
  /** The edit dialog is open. */
  protected readonly editing = signal(false);
  private readonly languageTrigger = viewChild('languageItem', { read: CdkMenuTrigger });

  /**
   * A click on "Language" leaves its submenu open. The menu opens it on hover already, and its
   * own click handling would then toggle it shut — the click people make right after hovering.
   */
  protected keepLanguagesOpen(): void {
    queueMicrotask(() => this.languageTrigger()?.open());
  }
}
