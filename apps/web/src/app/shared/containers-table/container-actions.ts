import { Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import type { ContainerAction, ContainerState } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucidePlay,
  lucideRotateCw,
  lucideScrollText,
  lucideSquare,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmAlertDialog, HlmAlertDialogImports } from '@ui/alert-dialog';
import { HlmButton } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { Translator } from '../../core/i18n/translator';
import { ICONS } from './container-actions.constants';

/** Actions that interrupt the container: they ask first. Starting interrupts nothing. */
type ConfirmedAction = Exclude<ContainerAction, 'start'>;

/** Items are buttons, not links: the menu handles Enter itself and would cancel a link's navigation. */
@Component({
  selector: 'laris-container-actions',
  imports: [HlmAlertDialogImports, HlmButton, HlmDropdownMenuImports, NgIcon, TranslatePipe],
  providers: [
    provideIcons({ lucideEllipsis, lucidePlay, lucideRotateCw, lucideScrollText, lucideSquare }),
  ],
  templateUrl: './container-actions.html',
})
export class ContainerActions {
  readonly name = input.required<string>();
  readonly state = input.required<ContainerState>();
  readonly protected = input(false);
  /** An action is running for this container (no other is offered meanwhile). */
  readonly busy = input(false);
  /** The chosen action — after the confirmation where one is asked. */
  readonly action = output<ContainerAction>();

  private readonly router = inject(Router);
  private readonly translator = inject(Translator);
  private readonly dialog = viewChild.required(HlmAlertDialog);

  protected readonly icons = ICONS;

  protected readonly actions = computed<ContainerAction[]>(() => {
    if (this.protected() || this.busy()) return [];
    switch (this.state()) {
      case 'running':
        return ['stop', 'restart'];
      case 'exited':
      case 'created':
        return ['start'];
      default:
        return []; // paused, restarting, removing, dead: nothing to offer yet
    }
  });

  /** The action waiting for confirmation in the dialog. */
  protected readonly confirming = signal<ConfirmedAction>('stop');
  /** The title around the name, which stays left to right in every language. */
  protected readonly title = computed(() =>
    this.translator.around(`containers.confirm.${this.confirming()}.title`, 'name'),
  );

  protected viewLogs(): void {
    void this.router.navigate(['/containers', this.name(), 'logs']);
  }

  protected choose(action: ContainerAction): void {
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
