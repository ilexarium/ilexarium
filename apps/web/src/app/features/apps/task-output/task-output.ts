import { Component, computed, effect, type ElementRef, input, viewChild } from '@angular/core';
import type { AppTask } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { TASK_STATE_TONES } from '../apps.constants';

/** A long task's live output and where it stands (it runs on as a unit, whoever watches). */
@Component({
  selector: 'laris-task-output',
  imports: [NgIcon, StatusBadge, TranslatePipe],
  providers: [provideIcons({ lucideLoaderCircle })],
  host: { class: 'grid gap-2' },
  templateUrl: './task-output.html',
})
export class TaskOutput {
  readonly task = input.required<AppTask>();
  /** The whole output so far (the task's own lines are only the newest). */
  readonly lines = input.required<readonly string[]>();
  protected readonly tones = TASK_STATE_TONES;
  protected readonly running = computed(() => this.task().state === 'running');
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');

  constructor() {
    // Follows the newest line while it runs.
    effect(() => {
      this.lines();
      const element = this.log()?.nativeElement;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }
}
