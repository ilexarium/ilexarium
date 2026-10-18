import { Component } from '@angular/core';
import { MARK_PATH } from './laris-mark.constants';

/**
 * The Laris mark, in the current text colour (so it follows the theme), sized by the host's
 * classes. Decorative: the name always stands beside it or in the link's label.
 */
@Component({
  selector: 'app-laris-mark',
  host: { class: 'inline-block shrink-0', 'aria-hidden': 'true' },
  templateUrl: './laris-mark.html',
})
export class LarisMark {
  protected readonly path = MARK_PATH;
}
