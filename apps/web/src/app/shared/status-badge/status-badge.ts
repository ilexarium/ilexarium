import { Component, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { BADGE_CLASSES, STATUS_ICONS, STATUS_TONES } from './status-badge.constants';
import type { StatusTone } from './status-badge.model';

/**
 * The one status badge every page uses: the text (the content) with the tone's icon and colours,
 * so a status is never told by colour alone. `<app-status-badge tone="failed">Failed</…>`.
 */
@Component({
  selector: 'app-status-badge',
  imports: [NgIcon],
  providers: [provideIcons(STATUS_ICONS)],
  host: { '[class]': 'classes()', '[attr.data-tone]': 'tone()' },
  templateUrl: './status-badge.html',
})
export class StatusBadge {
  readonly tone = input.required<StatusTone>();
  protected readonly icon = computed(() => STATUS_TONES[this.tone()].icon);
  protected readonly classes = computed(
    () => `${BADGE_CLASSES} ${STATUS_TONES[this.tone()].classes}`,
  );
}
