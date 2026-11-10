import { Component, computed, effect, type ElementRef, input, viewChild } from '@angular/core';
import type { AppTask } from '@ilex/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLoaderCircle } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { StatusBadge } from '../../../shared/status-badge/status-badge';
import { TASK_STATE_TONES } from '../apps.constants';

/** A long task's live output and where it stands (it runs on as a unit, whoever watches). */
@Component({
  selector: 'ilex-task-output',
  imports: [NgIcon, StatusBadge, TranslatePipe],
  providers: [provideIcons({ lucideLoaderCircle })],
  host: { class: 'grid gap-2' },
  templateUrl: './task-output.html',
})
export class TaskOutput {
  /** Its output is the end of its log, all of it each time. */
  readonly task = input.required<AppTask>();
  protected readonly tones = TASK_STATE_TONES;
  protected readonly running = computed(() => this.task().state === 'running');
  private readonly log = viewChild<ElementRef<HTMLElement>>('log');

  constructor() {
    // Follows the newest line while it runs.
    effect(() => {
      this.task().output;
      const element = this.log()?.nativeElement;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }
}
