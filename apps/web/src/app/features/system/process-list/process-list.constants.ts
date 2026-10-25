import type { Process } from '@laris/shared';
import type { ProcessSort } from '../processes.model';

/** Where the table starts (Tailwind's `lg`): below it, two lines a process. */
export const WIDE = '(min-width: 1024px)';

/** PageUp and PageDown move this many rows. */
export const PAGE_ROWS = 20;

/** CPU % (per core) and memory % from which the value is coloured. */
export const HIGH_CPU = 50;
export const HIGH_MEMORY = 10;

/** The kernel's state letters, as htop shows them. */
export const STATE_LETTERS: Record<Process['state'], string> = {
  running: 'R',
  sleeping: 'S',
  waiting: 'D',
  zombie: 'Z',
  stopped: 'T',
  idle: 'I',
  other: '?',
};

/**
 * The table's columns: their header (translation key under `processes.column`) and classes —
 * width, alignment, and PRI, NI, VIRT, SHR only on extra-large screens.
 */
export const COLUMNS: { sort: ProcessSort; end: boolean; classes: string }[] = [
  { sort: 'pid', end: true, classes: 'w-16' },
  { sort: 'user', end: false, classes: 'w-24' },
  { sort: 'priority', end: true, classes: 'hidden w-10 xl:table-cell' },
  { sort: 'nice', end: true, classes: 'hidden w-10 xl:table-cell' },
  { sort: 'virtual', end: true, classes: 'hidden w-[4.5rem] xl:table-cell' },
  { sort: 'resident', end: true, classes: 'w-[4.5rem]' },
  { sort: 'shared', end: true, classes: 'hidden w-[4.5rem] xl:table-cell' },
  { sort: 'state', end: false, classes: 'w-8' },
  { sort: 'cpu', end: true, classes: 'w-14' },
  { sort: 'memory', end: true, classes: 'w-14' },
  { sort: 'time', end: true, classes: 'w-[4.5rem]' },
  { sort: 'command', end: false, classes: '' },
];
