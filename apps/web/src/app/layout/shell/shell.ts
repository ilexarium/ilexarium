import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { HlmAvatarImports } from '@ui/avatar';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { AuthStore } from '../../core/auth/auth-store';

/** The signed-in layout: header with the user menu, then the routed page. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, HlmAvatarImports, HlmButton, HlmDropdownMenuImports],
  template: `
    <header class="flex items-center gap-4 border-b px-6 py-3">
      <a routerLink="/" class="font-semibold">Homelab</a>
      <button
        hlmBtn
        variant="ghost"
        class="ml-auto gap-2 px-2"
        [hlmDropdownMenuTrigger]="userMenu"
        align="end"
        aria-label="Account menu"
      >
        <hlm-avatar class="size-7">
          <span hlmAvatarFallback class="text-xs">{{ initials() }}</span>
        </hlm-avatar>
        <span class="text-sm">{{ auth.user()?.username }}</span>
      </button>
      <ng-template #userMenu>
        <hlm-dropdown-menu class="w-48">
          <div hlmDropdownMenuLabel>{{ auth.user()?.username }}</div>
          <hlm-dropdown-menu-separator />
          <a hlmDropdownMenuItem routerLink="/settings/account">Change password</a>
          <button hlmDropdownMenuItem (click)="auth.logout()">Sign out</button>
        </hlm-dropdown-menu>
      </ng-template>
    </header>
    <main class="mx-auto max-w-4xl p-6"><router-outlet /></main>
  `,
})
export class Shell {
  protected readonly auth = inject(AuthStore);
  protected readonly initials = computed(() =>
    (this.auth.user()?.username ?? '?').slice(0, 2).toUpperCase(),
  );
}
