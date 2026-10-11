import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { HlmButton } from '@ui/button';
import { AuthStore } from '../../core/auth/auth-store';

/** The signed-in layout. Step 9 turns the header into the full user menu. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, HlmButton],
  template: `
    <header class="flex items-center gap-4 border-b px-6 py-3">
      <a routerLink="/" class="font-semibold">Homelab</a>
      <span class="ml-auto text-sm text-muted-foreground">{{ auth.user()?.username }}</span>
      <button hlmBtn variant="ghost" size="sm" (click)="auth.logout()">Sign out</button>
    </header>
    <main class="mx-auto max-w-4xl p-6"><router-outlet /></main>
  `,
})
export class Shell {
  protected readonly auth = inject(AuthStore);
}
