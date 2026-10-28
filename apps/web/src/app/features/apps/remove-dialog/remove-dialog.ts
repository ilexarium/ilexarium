import { Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import type { AppRemovalItem } from '@laris/shared';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmSkeleton } from '@ui/skeleton';
import { PluralPipe } from '../../../core/i18n/plural-pipe';
import { Formatter } from '../../../shared/format/formatter';

/**
 * Removing an app: its containers go (`docker compose down`); every item it could delete listed,
 * none ticked — its settings, each data folder (one outside the app's folder may be used
 * elsewhere), each named volume. Backups stay. UI only: the page opens it and loads the list.
 */
@Component({
  selector: 'laris-remove-dialog',
  imports: [HlmAlertDialogImports, HlmSkeleton, PluralPipe, TranslatePipe],
  templateUrl: './remove-dialog.html',
})
export class RemoveDialog {
  readonly name = input.required<string>();
  /** Null while the list loads. */
  readonly items = input<AppRemovalItem[] | null>(null);
  readonly remove = output<AppRemovalItem[]>();

  protected readonly formatter = inject(Formatter);
  private readonly dialog = viewChild.required(HlmAlertDialog);
  protected readonly ticked = signal<ReadonlySet<string>>(new Set());
  protected readonly count = computed(() => this.ticked().size);
  protected readonly warnOutside = computed(() =>
    (this.items() ?? []).some((item) => item.outside && this.ticked().has(key(item))),
  );
  protected readonly key = key;

  open(): void {
    this.ticked.set(new Set());
    this.dialog().open();
  }

  protected toggle(item: AppRemovalItem, event: Event): void {
    const next = new Set(this.ticked());
    if ((event.target as HTMLInputElement).checked) next.add(key(item));
    else next.delete(key(item));
    this.ticked.set(next);
  }

  protected confirmed(): void {
    const ticked = (this.items() ?? []).filter((item) => this.ticked().has(key(item)));
    this.dialog().close();
    this.remove.emit(ticked);
  }
}

const key = (item: AppRemovalItem) => `${item.kind}:${item.path}`;
