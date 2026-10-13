import { Component, computed, input } from '@angular/core';
import type { JobPhase, ServiceJob } from '@homelab/shared';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleDashed,
  lucideCircleX,
  lucideLoaderCircle,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';

type StepState = 'done' | 'current' | 'failed' | 'waiting';

const STEPS: Record<ServiceJob['kind'], JobPhase[]> = {
  deploy: ['pulling', 'starting', 'done'],
  remove: ['removing', 'done'],
};

/**
 * A job's progress: its steps (Downloading → Starting → Ready, or Removing → Done), what went
 * wrong if it failed, and its output — always shown as text, left to right.
 */
@Component({
  selector: 'app-job-progress',
  imports: [NgIcon, TranslatePipe],
  providers: [
    provideIcons({ lucideCircleCheck, lucideCircleDashed, lucideCircleX, lucideLoaderCircle }),
  ],
  templateUrl: './job-progress.html',
})
export class JobProgress {
  readonly job = input.required<ServiceJob>();

  protected readonly steps = computed(() => {
    const job = this.job();
    const steps = STEPS[job.kind];
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

  protected readonly icons: Record<StepState, string> = {
    done: 'lucideCircleCheck',
    current: 'lucideLoaderCircle',
    failed: 'lucideCircleX',
    waiting: 'lucideCircleDashed',
  };
}
