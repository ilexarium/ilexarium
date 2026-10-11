import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { HlmButton } from '@ui/button';
import { AuthStore } from './core/auth/auth-store';

@Component({
  imports: [RouterOutlet, HlmButton],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  /** Ask the server again, then re-run the current navigation (guards included). */
  protected async retry(): Promise<void> {
    await this.auth.load();
    if (this.auth.status() !== 'unreachable') {
      await this.router.navigateByUrl(this.router.url, { onSameUrlNavigation: 'reload' });
    }
  }
}
