import { Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';

/**
 * A bar stuck to the bottom while there are unsaved changes: "Unsaved changes", Discard, Save.
 * Inside a form, Save can be its submit button. Content given to it is shown above the row (or
 * instead of it, with `actions` off — e.g. a conflict to settle first).
 */
@Component({
  selector: 'laris-save-bar',
  imports: [HlmButton, TranslatePipe],
  host: {
    class:
      'sticky bottom-0 z-10 -mx-1 grid gap-3 rounded-t-xl border bg-background/95 p-3 shadow-lg backdrop-blur',
    'data-save-bar': '',
  },
  templateUrl: './save-bar.html',
})
export class SaveBar {
  /** The Save button's text, a translation key. */
  readonly saveLabel = input('saveBar.save');
  readonly busy = input(false);
  /** Save submits the form it's in. */
  readonly submit = input(false);
  readonly actions = input(true);

  readonly discard = output<void>();
  readonly save = output<void>();
}
