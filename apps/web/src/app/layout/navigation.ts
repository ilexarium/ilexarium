import { lucideBoxes, lucideKeyRound, lucideLayoutDashboard } from '@ng-icons/lucide';
import type { NavGroup } from './layout.model';

/** Existing pages only — each feature adds its own entry. */
export const NAVIGATION: NavGroup[] = [
  {
    items: [
      { label: 'Dashboard', link: '/', icon: 'lucideLayoutDashboard', exact: true },
      { label: 'Containers', link: '/containers', icon: 'lucideBoxes' },
    ],
  },
  {
    label: 'Settings',
    items: [{ label: 'Account', link: '/settings/account', icon: 'lucideKeyRound' }],
  },
];

export const NAV_ICONS = { lucideLayoutDashboard, lucideBoxes, lucideKeyRound };
