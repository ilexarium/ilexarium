import { Component, computed, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchiveRestore,
  lucideBox,
  lucideEllipsis,
  lucideFolder,
  lucidePlay,
  lucideServer,
  lucideTrash2,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { Formatter } from '../../../shared/format/formatter';
import { StatusDot } from '../../../shared/status-dot/status-dot';
import type { DotTone } from '../../../shared/status-dot/status-dot.model';
import { ITEM_STATUS_DOTS } from '../backups.constants';
import type { ItemLabel, ItemRow } from '../backups.model';

/**
 * One backed-up item on the Backups page: its icon, name, state, when it was last backed up and
 * how big; "⋯" for Back up now, Restore…, Remove. The card opens its side sheet (`open`).
 */
@Component({
  selector: 'laris-item-card',
  imports: [HlmButton, HlmDropdownMenuImports, NgIcon, StatusDot, TranslatePipe],
  providers: [
    provideIcons({
      lucideArchiveRestore,
      lucideBox,
      lucideEllipsis,
      lucideFolder,
      lucidePlay,
      lucideServer,
      lucideTrash2,
    }),
  ],
  host: { class: 'block' },
  templateUrl: './item-card.html',
})
export class ItemCard {
  readonly row = input.required<ItemRow>();
  readonly label = input<ItemLabel>({ text: '', ltr: false });
  /** This item is being backed up now. */
  readonly backingUp = input(false);
  /** A run is going: no "Back up now" meanwhile. */
  readonly runBusy = input(false);
  readonly pending = input<string[]>([]);

  readonly open = output<void>();
  readonly runNow = output<void>();
  readonly restore = output<void>();
  readonly remove = output<void>();

  protected readonly formatter = inject(Formatter);
  protected readonly kindIcon = computed(() => {
    const { kind } = this.row().item;
    return kind === 'platform' ? 'lucideServer' : kind === 'folder' ? 'lucideFolder' : 'lucideBox';
  });
  protected readonly state = computed((): { tone: DotTone; key: string } => {
    if (this.backingUp()) return { tone: 'busy', key: 'backups.status.running' };
    const status = this.row().item.lastResult?.status;
    return status
      ? { tone: ITEM_STATUS_DOTS[status], key: `backups.status.${status}` }
      : { tone: 'idle', key: 'backups.items.new' };
  });
}
