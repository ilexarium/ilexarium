import { Component, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArchiveRestore } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { CopyCommand } from '../../../shared/copy-command/copy-command';

/**
 * Before backups are set up: moving from another machine, Ilexarium comes back from its backup
 * disk instead (or `sudo ilex-recover` on the server). UI only: `restore` opens the dialog.
 */
@Component({
  selector: 'ilex-recover-card',
  imports: [CopyCommand, HlmButton, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideArchiveRestore })],
  templateUrl: './recover-card.html',
})
export class RecoverCard {
  readonly restore = output<void>();
}
