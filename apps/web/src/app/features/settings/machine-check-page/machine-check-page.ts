import { Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleDashed,
  lucideCircleMinus,
  lucideCircleX,
  lucideInfo,
  lucideLoaderCircle,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButton } from '@ui/button';
import { STATUS_COLORS, STATUS_ICONS } from './machine-check-page.constants';
import { MachineCheckPageStore } from './machine-check-page-store';

/**
 * Settings → Machine check (docs/plans/machine_check.md): is this machine set up the way Laris
 * needs, checked as the signed-in Linux account — each step passed, or what's wrong and what to do.
 */
@Component({
  selector: 'laris-machine-check-page',
  imports: [HlmButton, NgIcon, TranslatePipe],
  providers: [
    MachineCheckPageStore,
    provideIcons({
      lucideCircleCheck,
      lucideCircleDashed,
      lucideCircleMinus,
      lucideCircleX,
      lucideInfo,
      lucideLoaderCircle,
    }),
  ],
  templateUrl: './machine-check-page.html',
})
export class MachineCheckPage {
  protected readonly machineCheckPageStore = inject(MachineCheckPageStore);
  protected readonly icons = STATUS_ICONS;
  protected readonly colors = STATUS_COLORS;
}
