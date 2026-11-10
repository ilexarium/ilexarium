import { Component, input, output } from '@angular/core';
import type { BackupFoldersResponse } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCornerLeftUp, lucideFolder } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmSkeleton } from '@ui/skeleton';

/**
 * Choosing a folder to back up: the storage folders and home folders, then the folders inside.
 * Shown while `open`; the page store loads each place (`listing`). UI only: it asks for places
 * through `browse`, and reports the chosen folder through `choose` — or `cancel` when it was
 * closed (Cancel, Escape).
 */
@Component({
  selector: 'ilex-folder-picker',
  imports: [HlmAlertDialogImports, HlmButton, HlmSkeleton, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideCornerLeftUp, lucideFolder })],
  templateUrl: './folder-picker.html',
})
export class FolderPicker {
  /** The place shown; null while it loads. */
  readonly listing = input<BackupFoldersResponse | null>(null);
  readonly open = input(false);

  /** Show this place (none: the starting places). */
  readonly browse = output<string | undefined>();
  readonly choose = output<string>();
  readonly cancel = output<void>();

  /** Closed by the dialog itself (Cancel, Escape): the page closes the picker too. */
  protected closed(): void {
    if (this.open()) this.cancel.emit();
  }
}
