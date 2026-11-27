import { Component, inject, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCopy } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { toast } from '@spartan-ng/brain/sonner';
import { HlmButton } from '@ui/button';
import { Translator } from '../../core/i18n/translator';

/** A command to run in a terminal, with a button that copies it. */
@Component({
  selector: 'ilex-copy-command',
  imports: [HlmButton, NgIcon, TranslatePipe],
  providers: [provideIcons({ lucideCheck, lucideCopy })],
  templateUrl: './copy-command.html',
  // A long command scrolls inside it, never the page.
  host: { class: 'block min-w-0' },
})
export class CopyCommand {
  readonly command = input.required<string>();

  private readonly translator = inject(Translator);
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.command());
      this.copied.set(true);
    } catch {
      toast.error(this.translator.t('copyCommand.failed'));
    }
  }
}
