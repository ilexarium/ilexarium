import type { UpdatePhase } from '@ilex/shared';

/** The installer's steps while the app is down: the page says it's restarting. */
export const OFFLINE_PHASES: readonly UpdatePhase[] = [
  'stopped',
  'migrated',
  'installed',
  'started',
];
