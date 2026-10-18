import {
  lucideCircleCheck,
  lucideCircleDot,
  lucideCircleX,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import type { StatusTone } from './status-badge.model';

export const STATUS_ICONS = {
  lucideCircleCheck,
  lucideCircleDot,
  lucideCircleX,
  lucideTriangleAlert,
};

/** Each tone's colours (the status tokens in `styles.css`) and icon; neutral has neither. */
export const STATUS_TONES: Record<StatusTone, { classes: string; icon: string | null }> = {
  healthy: { classes: 'bg-success-muted text-success', icon: 'lucideCircleCheck' },
  warning: { classes: 'bg-warning-muted text-warning', icon: 'lucideTriangleAlert' },
  failed: { classes: 'bg-destructive-muted text-destructive', icon: 'lucideCircleX' },
  info: { classes: 'bg-info-muted text-info', icon: 'lucideCircleDot' },
  neutral: { classes: 'border-border text-foreground', icon: null },
};

/** The shape of spartan's badge (`ui/badge`), which this replaces for statuses. */
export const BADGE_CLASSES =
  'inline-flex h-5 w-fit max-w-full shrink-0 items-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap';
