import { Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import {
  systemServiceActionAllowed,
  type SystemServiceAction,
  type SystemServiceProtection,
} from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucideInfo,
  lucidePlay,
  lucideRotateCw,
  lucideSquare,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { Translator } from '../../../core/i18n/translator';
import type { ServiceGroup } from '../system-services.model';
import { ICONS } from './service-actions.constants';

type ConfirmedAction = Exclude<SystemServiceAction, 'start'>;

/**
 * A service's menu: its details, and what its state and protection allow. Stop and restart ask
 * first (a service Ilexarium needs says so); start interrupts nothing.
 */
@Component({
  selector: 'ilex-service-actions',
  imports: [HlmAlertDialogImports, HlmButton, HlmDropdownMenuImports, NgIcon, TranslatePipe],
  providers: [
    provideIcons({ lucideEllipsis, lucideInfo, lucidePlay, lucideRotateCw, lucideSquare }),
  ],
  templateUrl: './service-actions.html',
})
export class ServiceActions {
  readonly name = input.required<string>();
  readonly group = input.required<ServiceGroup>();
  readonly protection = input<SystemServiceProtection | null>(null);
  /** An action of its runs: no other meanwhile. */
  readonly busy = input(false);
  readonly action = output<SystemServiceAction>();
  readonly details = output<void>();

  private readonly translator = inject(Translator);
  private readonly dialog = viewChild.required(HlmAlertDialog);
  protected readonly icons = ICONS;

  protected readonly actions = computed<SystemServiceAction[]>(() => {
    if (this.busy()) return [];
    const offered: SystemServiceAction[] =
      this.group() === 'active' ? ['stop', 'restart'] : ['start'];
    return offered.filter((action) => systemServiceActionAllowed(this.protection(), action));
  });

  protected readonly confirming = signal<ConfirmedAction>('stop');
  protected readonly title = computed(() =>
    this.translator.around(`systemServices.confirm.${this.confirming()}.title`, 'name'),
  );

  protected choose(action: SystemServiceAction): void {
    if (action === 'start') {
      this.action.emit(action);
      return;
    }
    this.confirming.set(action);
    this.dialog().open();
  }

  protected confirm(): void {
    this.dialog().close();
    this.action.emit(this.confirming());
  }
}
