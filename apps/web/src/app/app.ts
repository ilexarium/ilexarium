import { Component, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { HlmButton } from '@ui/button';
import { HlmToaster } from '@ui/sonner';
import { AuthStore } from './core/auth/auth-store';
import { TranslatePipe } from '@ngx-translate/core';
import { APP_NAME } from './core/page-title/page-title';

@Component({
  imports: [RouterOutlet, HlmButton, HlmToaster, TranslatePipe],
  selector: 'laris-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly appName = APP_NAME;
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
