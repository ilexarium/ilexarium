import type { Wording } from '../../core/alerts/alert-wording';

/** One alert as the menu shows it. */
export interface AlertsMenuRow {
  id: string;
  title: Wording;
  /** "10 minutes ago" (open) or "Resolved 2 days ago". */
  when: Wording;
  icon: string;
  /** The icon's colour class. */
  iconClass: string;
  acknowledged: boolean;
  /** Resolved: greyed out, below the open ones. */
  resolved: boolean;
  link: string[];
}
