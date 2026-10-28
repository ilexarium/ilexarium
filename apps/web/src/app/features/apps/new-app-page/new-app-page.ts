import { Component, effect, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { catalogIconPath, type FieldKind } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideClipboardPaste, lucideX } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmCardImports } from '@ui/card';
import { HlmInput } from '@ui/input';
import { HlmLabel } from '@ui/label';
import { HlmSkeleton } from '@ui/skeleton';
import { HlmTextarea } from '@ui/textarea';
import { AppFields } from '../app-fields/app-fields';
import type { FieldChange } from '../apps.model';
import { TaskOutput } from '../task-output/task-output';
import { NewAppPageStore } from './new-app-page-store';

/** Add app: a template or a pasted Compose file, the setup form, the install. */
@Component({
  selector: 'laris-new-app-page',
  imports: [
    AppFields,
    HlmButton,
    HlmCardImports,
    HlmInput,
    HlmLabel,
    HlmSkeleton,
    HlmTextarea,
    NgIcon,
    RouterLink,
    TaskOutput,
    TranslatePipe,
  ],
  providers: [NewAppPageStore, provideIcons({ lucideArrowLeft, lucideClipboardPaste, lucideX })],
  templateUrl: './new-app-page.html',
})
export class NewAppPage {
  protected readonly newAppPageStore = inject(NewAppPageStore);
  private readonly router = inject(Router);
  protected readonly iconPath = catalogIconPath;
  protected readonly pasted = signal('');
  protected readonly newSkip = signal('');

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
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected change(change: FieldChange): void {
    this.newAppPageStore.setValue(change.key, change.value);
  }

  protected kind(change: { key: string; kind: FieldKind }): void {
    this.newAppPageStore.setKind(change.key, change.kind);
  }

  protected addSkip(): void {
    const skip = this.newSkip()
      .trim()
      .replace(/^\.?\/+/, '');
    if (!skip) return;
    const { skip: list } = this.newAppPageStore.backup();
    if (!list.includes(skip)) this.newAppPageStore.setBackup({ skip: [...list, skip] });
    this.newSkip.set('');
  }

  protected removeSkip(skip: string): void {
    this.newAppPageStore.setBackup({
      skip: this.newAppPageStore.backup().skip.filter((s) => s !== skip),
    });
  }
}
