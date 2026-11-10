import type { JournalPriority } from '@ilex/shared';

/** What the Logs page shows: one unit or all, how urgent, which boot. */
export interface JournalFilters {
  unit: string | null;
  priority: JournalPriority;
  /** A boot's ID, `-1` (the previous one), or null: this boot. */
  boot: string | null;
}

/** A choice in the boot menu: its value for `JournalFilters.boot`, and its time span. */
export interface BootChoice {
  value: string | null;
  offset: number;
  first: string | null;
  last: string | null;
}
