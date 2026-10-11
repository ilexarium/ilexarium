import { lucideBoxes, lucideKeyRound, lucideLayoutDashboard } from '@ng-icons/lucide';

export interface NavItem {
  label: string;
  link: string;
  /** Lucide icon name, registered with `provideIcons(NAV_ICONS)`. */
  icon: string;
  /** Active only on this exact URL (for `/`, which every URL starts with). */
  exact?: boolean;
}

export interface NavGroup {
  /** Omitted for the top-level group. */
  label?: string;
  items: NavItem[];
}

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
