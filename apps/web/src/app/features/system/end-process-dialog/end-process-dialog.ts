import { Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { Translator } from '../../../core/i18n/translator';
import { Formatter } from '../../../shared/format/formatter';
import type { EndRequest } from '../processes.model';

/**
 * Confirming the end of a process: asked to stop (it can save its work), or forced (at once, its
 * unsaved work lost); another account's says it goes through the Linux account's sudo. UI only:
 * the page opens it; the choice goes out through `confirm`.
 */
@Component({
  selector: 'laris-end-process-dialog',
  imports: [HlmAlertDialogImports, TranslatePipe],
  templateUrl: './end-process-dialog.html',
})
export class EndProcessDialog {
  /** The signed-in Linux account (named when its sudo is used). */
  readonly account = input<string | null>(null);
  readonly confirm = output<EndRequest>();

  private readonly dialog = viewChild.required(HlmAlertDialog);
  private readonly translator = inject(Translator);
  private readonly formatter = inject(Formatter);
  protected readonly request = signal<EndRequest | null>(null);
  protected readonly asAdministrator = signal(false);
  protected readonly accountText = computed(() => this.formatter.machine(this.account() ?? ''));

  open(request: EndRequest, asAdministrator: boolean): void {
    this.request.set(request);
    this.asAdministrator.set(asAdministrator);
    this.dialog().open();
  }

  protected user(request: EndRequest): string {
    return this.formatter.machine(
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
