import { Component, inject, output, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import type { EndRequest } from '../processes.model';

/**
 * Confirming the end of a process: asked to stop (it can save its work), or forced (at once, its
 * unsaved work lost). UI only: the page opens it; the choice goes out through `confirm`.
 */
@Component({
  selector: 'app-end-process-dialog',
  imports: [HlmAlertDialogImports, TranslatePipe],
  templateUrl: './end-process-dialog.html',
})
export class EndProcessDialog {
  readonly confirm = output<EndRequest>();

  private readonly dialog = viewChild.required(HlmAlertDialog);
  private readonly translator = inject(Translator);
  private readonly format = inject(Formatter);
  protected readonly request = signal<EndRequest | null>(null);

  open(request: EndRequest): void {
    this.request.set(request);
    this.dialog().open();
  }

  protected user(request: EndRequest): string {
    return this.format.machine(
      request.process.user ??
        this.translator.t('processes.unknownUser', { uid: request.process.uid }),
    );
  }

  protected confirmed(): void {
    const request = this.request();
    this.dialog().close();
    if (request) this.confirm.emit(request);
  }
}
