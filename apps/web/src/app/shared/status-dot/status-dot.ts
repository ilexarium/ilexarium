import { Component, computed, input } from '@angular/core';
import { DOT_CLASSES } from './status-dot.constants';
import type { DotTone } from './status-dot.model';

/** A state's dot and its word (the content): the dot is decorative, the word says it. */
@Component({
  selector: 'laris-status-dot',
  host: { class: 'inline-flex items-center gap-1.5' },
  templateUrl: './status-dot.html',
})
export class StatusDot {
  readonly tone = input.required<DotTone>();
  protected readonly dotClass = computed(() => DOT_CLASSES[this.tone()]);
}
