import { Component, computed, input } from '@angular/core';
import type { JobPhase, Job } from '@laris/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleDashed,
  lucideCircleX,
  lucideLoaderCircle,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { STEP_ICONS, STEPS } from './job-progress.constants';
import type { StepState } from './job-progress.model';

/** Its output is always shown as text, left to right (it can hold anything). */
@Component({
  selector: 'laris-job-progress',
  imports: [NgIcon, TranslatePipe],
  providers: [
    provideIcons({ lucideCircleCheck, lucideCircleDashed, lucideCircleX, lucideLoaderCircle }),
  ],
  templateUrl: './job-progress.html',
})
export class JobProgress {
  readonly job = input.required<Job>();
  /** The steps of this job, when not every one of its kind applies (a restore to a new folder). */
  readonly phases = input<JobPhase[] | null>(null);

  protected readonly steps = computed(() => {
    const job = this.job();
    const steps = this.phases() ?? STEPS[job.kind];
    const reached = job.phase ? steps.indexOf(job.phase) : -1;
    return steps.map((phase, i): { phase: JobPhase; state: StepState } => {
      if (job.status === 'succeeded') return { phase, state: 'done' };
      if (i < reached) return { phase, state: 'done' };
      if (i === Math.max(reached, 0)) {
        return { phase, state: job.status === 'running' ? 'current' : 'failed' };
      }
      return { phase, state: 'waiting' };
    });
  });

  protected readonly icons = STEP_ICONS;
}
