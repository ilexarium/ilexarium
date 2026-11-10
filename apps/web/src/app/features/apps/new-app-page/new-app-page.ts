import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { catalogIconPath } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideFileCode, lucideSearch } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmInput } from '@ui/input';
import { HlmLabel } from '@ui/label';
import { HlmSkeleton } from '@ui/skeleton';
import { AppHeader } from '../app-header/app-header';
import { AppSettings } from '../app-settings/app-settings';
import type { FieldChange } from '../apps.model';
import { BackupOptions } from '../backup-options/backup-options';
import { TaskOutput } from '../task-output/task-output';
import { NewAppPageStore } from './new-app-page-store';

/** Add app: choose a template or your own Compose file, set it up, install. */
@Component({
  selector: 'ilex-new-app-page',
  imports: [
    AppHeader,
    AppSettings,
    BackupOptions,
    HlmButton,
    HlmInput,
    HlmLabel,
    HlmSkeleton,
    NgIcon,
    NgTemplateOutlet,
    RouterLink,
    TaskOutput,
    TranslatePipe,
  ],
  providers: [NewAppPageStore, provideIcons({ lucideArrowLeft, lucideFileCode, lucideSearch })],
  templateUrl: './new-app-page.html',
})
export class NewAppPage {
  protected readonly newAppPageStore = inject(NewAppPageStore);
  private readonly router = inject(Router);
  protected readonly iconPath = catalogIconPath;
  protected readonly defaultFolder = computed(() => `~/apps/${this.newAppPageStore.name()}`);

  constructor() {
    // Installed: on to its page.
    effect(() => {
      const installed = this.newAppPageStore.installed();
      if (installed) {
        void this.router.navigate(['/apps', installed.name], {
          queryParams: { folder: installed.folder },
        });
      }
    });
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected change(change: FieldChange): void {
    this.newAppPageStore.setValue(change.key, change.value);
  }
}
