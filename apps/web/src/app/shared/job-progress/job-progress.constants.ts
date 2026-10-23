import type { Job, JobPhase } from '@laris/shared';
import {
  lucideCircleCheck,
  lucideCircleDashed,
  lucideCircleX,
  lucideLoaderCircle,
} from '@ng-icons/lucide';
import type { StepState } from './job-progress.model';

export const JOB_STEPS: Record<Job['kind'], JobPhase[]> = {
  deploy: ['pulling', 'starting', 'done'],
  remove: ['removing', 'done'],
  restore: ['stopping', 'restoring', 'starting', 'done'],
};

/** Provided by the component; `STEP_ICONS` can only name one of these. */
export const JOB_ICONS = {
  lucideCircleCheck,
  lucideCircleDashed,
  lucideCircleX,
  lucideLoaderCircle,
};

export const STEP_ICONS: Record<StepState, keyof typeof JOB_ICONS> = {
  done: 'lucideCircleCheck',
  current: 'lucideLoaderCircle',
  failed: 'lucideCircleX',
  waiting: 'lucideCircleDashed',
};
