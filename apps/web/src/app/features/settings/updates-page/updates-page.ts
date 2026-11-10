import { Component, inject, viewChild } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucideCircleArrowUp,
  lucideCircleCheck,
  lucideLoaderCircle,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmProgressImports } from '@ui/progress';
import { Formatter } from '../../../shared/format/formatter';
import { UpdatesPageStore } from './updates-page-store';

/**
 * Settings → Updates (docs/plans/install_and_update.md): the installed version, a newer signed
 * release with its notes, updating with one click (confirmed, then the person's sudo), the
 * update's progress through Ilexarium's restart, and the daily check's switch.
 */
@Component({
  selector: 'ilex-updates-page',
  imports: [HlmAlertDialogImports, HlmButton, HlmProgressImports, NgIcon, TranslatePipe],
  providers: [
    UpdatesPageStore,
    provideIcons({ lucideCircleAlert, lucideCircleArrowUp, lucideCircleCheck, lucideLoaderCircle }),
  ],
  templateUrl: './updates-page.html',
})
export class UpdatesPage {
  protected readonly updatesPageStore = inject(UpdatesPageStore);
  protected readonly formatter = inject(Formatter);
  private readonly confirmDialog = viewChild.required<HlmAlertDialog>('confirmDialog');

  protected confirm(): void {
    this.confirmDialog().open();
  }

  protected update(version: string): void {
    this.confirmDialog().close();
    void this.updatesPageStore.start(version);
  }

  protected percent(bytes: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
  }
}
