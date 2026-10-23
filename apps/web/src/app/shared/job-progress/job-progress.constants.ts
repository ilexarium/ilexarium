import type { Job, JobPhase } from '@laris/shared';
import type { StepState } from './job-progress.model';

export const STEPS: Record<Job['kind'], JobPhase[]> = {
  deploy: ['pulling', 'starting', 'done'],
  remove: ['removing', 'done'],
  restore: ['stopping', 'restoring', 'starting', 'done'],
};

export const STEP_ICONS: Record<StepState, string> = {
  done: 'lucideCircleCheck',
  current: 'lucideLoaderCircle',
  failed: 'lucideCircleX',
  waiting: 'lucideCircleDashed',
};
