import {
  lucideArchive,
  lucideBell,
  lucideBellRing,
  lucideBlocks,
  lucideBoxes,
  lucideHardDrive,
  lucideKeyRound,
  lucideLayoutDashboard,
} from '@ng-icons/lucide';
import type { NavGroup } from './layout.model';

/** Existing pages only — each feature adds its own entry. */
export const NAVIGATION: NavGroup[] = [
  {
    items: [
      { label: 'nav.dashboard', link: '/', icon: 'lucideLayoutDashboard', exact: true },
      { label: 'nav.containers', link: '/containers', icon: 'lucideBoxes' },
      { label: 'nav.services', link: '/services', icon: 'lucideBlocks' },
      { label: 'nav.backups', link: '/backups', icon: 'lucideArchive', attention: 'backups' },
      { label: 'nav.alerts', link: '/alerts', icon: 'lucideBell', attention: 'alerts' },
    ],
  },
  {
    label: 'nav.storage',
    items: [{ label: 'nav.disks', link: '/disks', icon: 'lucideHardDrive' }],
  },
  {
    label: 'nav.settings',
    items: [
      { label: 'nav.account', link: '/settings/account', icon: 'lucideKeyRound' },
      { label: 'nav.notifications', link: '/settings/notifications', icon: 'lucideBellRing' },
    ],
  },
];

export const NAV_ICONS = {
  lucideLayoutDashboard,
  lucideBoxes,
  lucideBlocks,
  lucideArchive,
  lucideBell,
  lucideBellRing,
  lucideHardDrive,
  lucideKeyRound,
};
