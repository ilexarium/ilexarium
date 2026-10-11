import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmAvatarImports } from '@ui/avatar';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmSeparator } from '@ui/separator';
import { HlmSidebarTrigger } from '@ui/sidebar';
import { AuthStore } from '../../core/auth/auth-store';
import { PageTitleStrategy } from '../../core/page-title/page-title';
import { ConnectionStatus } from '../connection-status/connection-status';
import { ThemeMenu } from '../theme-menu/theme-menu';

/** Sidebar toggle, the page title (the page's only h1), the live-data status, the theme switch and the user menu. */
@Component({
  selector: 'app-top-bar',
  imports: [
    RouterLink,
    HlmAvatarImports,
    HlmButton,
    HlmDropdownMenuImports,
    HlmSeparator,
    HlmSidebarTrigger,
    ConnectionStatus,
    ThemeMenu,
  ],
  host: {
    class: 'sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4',
  },
  templateUrl: './top-bar.html',
})
export class TopBar {
  protected readonly auth = inject(AuthStore);
  protected readonly pageTitle = inject(PageTitleStrategy).pageTitle;
  protected readonly initials = computed(() =>
    (this.auth.user()?.username ?? '?').slice(0, 2).toUpperCase(),
  );
}
