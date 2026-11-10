import type { JournalPriority } from '@ilex/shared';

/** What is read: the filters, a direction, and whether through the account's sudo. */
export interface JournalRequest {
  unit: string | null;
  priority: JournalPriority;
  /** A boot's ID, `-1` (the previous one), or null: this boot. */
  boot: string | null;
  after?: string;
  before?: string;
  administrator: boolean;
}
