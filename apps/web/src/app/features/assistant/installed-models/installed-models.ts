import { Component, inject, input, output, signal, viewChild } from '@angular/core';
import type { AiModel } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTrash2 } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { Formatter } from '../../../shared/format/formatter';
import { StatusBadge } from '../../../shared/status-badge/status-badge';

/**
 * The installed models: name, size, family, parameters, quantisation, whether it's loaded;
 * Remove after a confirmation. Presentational: a confirmed Remove goes out through `remove`.
 */
@Component({
  selector: 'laris-installed-models',
  imports: [HlmAlertDialogImports, HlmButton, NgIcon, StatusBadge, TranslatePipe],
  providers: [provideIcons({ lucideTrash2 })],
  host: { class: 'block' },
  templateUrl: './installed-models.html',
})
export class InstalledModels {
  readonly models = input.required<AiModel[]>();
  /** Models being removed. */
  readonly removing = input<string[]>([]);
  readonly remove = output<string>();

  protected readonly formatter = inject(Formatter);
  protected readonly asking = signal<string | null>(null);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  protected confirmRemove(model: string): void {
    this.asking.set(model);
    this.dialog().open();
  }

  protected confirmed(): void {
    const model = this.asking();
    this.dialog().close();
    if (model) this.remove.emit(model);
  }
}
