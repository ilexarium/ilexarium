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

/** Sidebar toggle, the page title (the page's only h1), the live-data status and the user menu. */
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
  ],
  host: {
    class: 'sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4',
  },
  template: `
    <button hlmSidebarTrigger srOnlyText="Toggle navigation" class="-ms-1"></button>
    <hlm-separator orientation="vertical" class="me-2 h-4" />
    <h1 class="truncate text-base font-semibold">{{ pageTitle() }}</h1>
    <app-connection-status class="ms-auto" />
    <button
      hlmBtn
      variant="ghost"
      class="gap-2 px-2"
      [hlmDropdownMenuTrigger]="userMenu"
      align="end"
      aria-label="Account menu"
    >
      <hlm-avatar class="size-7">
        <span hlmAvatarFallback class="text-xs">{{ initials() }}</span>
      </hlm-avatar>
      <span class="hidden text-sm sm:inline">{{ auth.user()?.username }}</span>
    </button>
    <ng-template #userMenu>
      <hlm-dropdown-menu class="w-48">
        <div hlmDropdownMenuLabel>{{ auth.user()?.username }}</div>
        <hlm-dropdown-menu-separator />
        <a hlmDropdownMenuItem routerLink="/settings/account">Change password</a>
        <button hlmDropdownMenuItem (click)="auth.logout()">Sign out</button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class TopBar {
  protected readonly auth = inject(AuthStore);
  protected readonly pageTitle = inject(PageTitleStrategy).pageTitle;
  protected readonly initials = computed(() =>
    (this.auth.user()?.username ?? '?').slice(0, 2).toUpperCase(),
  );
}
