import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { EMPTY_ICONS } from './empty-state.constants';
import type { EmptyIcon } from './empty-state.model';

/**
 * What a list shows when there's nothing in it: an icon, one sentence (`text`, optionally a
 * `detail` below), and the next action as content (a link or a button), if there is one.
 */
@Component({
  selector: 'app-empty-state',
  imports: [NgIcon],
  providers: [provideIcons(EMPTY_ICONS)],
  host: {
    class: 'flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center',
  },
  templateUrl: './empty-state.html',
})
export class EmptyState {
  readonly icon = input.required<EmptyIcon>();
  readonly text = input.required<string>();
  readonly detail = input<string>();
}
