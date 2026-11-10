import { Component } from '@angular/core';
import { MARK_PATH } from './ilex-mark.constants';

/**
 * The Ilexarium mark, in the current text colour (so it follows the theme), sized by the host's
 * classes. Decorative: the name always stands beside it or in the link's label.
 */
@Component({
  selector: 'ilex-mark',
  host: { class: 'inline-block shrink-0', 'aria-hidden': 'true' },
  templateUrl: './ilex-mark.html',
})
export class IlexMark {
  protected readonly path = MARK_PATH;
}
