import {
  lucideActivity,
  lucideArchive,
  lucideBell,
  lucideBellRing,
  lucideBlocks,
  lucideBoxes,
  lucideFolderOpen,
  lucideHardDrive,
  lucideLayoutDashboard,
  lucideScrollText,
  lucideServerCog,
  lucideSquareTerminal,
} from '@ng-icons/lucide';
import type { NavGroup } from './layout.model';

/** Existing pages only — each feature adds its own entry. */
export const NAVIGATION: NavGroup[] = [
  {
    items: [
      { label: 'nav.dashboard', link: '/', icon: 'lucideLayoutDashboard', exact: true },
      { label: 'nav.containers', link: '/containers', icon: 'lucideBoxes' },
      { label: 'nav.apps', link: '/apps', icon: 'lucideBlocks' },
      { label: 'nav.backups', link: '/backups', icon: 'lucideArchive', attention: 'backups' },
      { label: 'nav.alerts', link: '/alerts', icon: 'lucideBell', attention: 'alerts' },
    ],
  },
  {
    label: 'nav.storage',
    items: [{ label: 'nav.disks', link: '/disks', icon: 'lucideHardDrive' }],
  },
  {
    label: 'nav.system',
    items: [
      { label: 'nav.processes', link: '/system/processes', icon: 'lucideActivity' },
      { label: 'nav.services', link: '/system/services', icon: 'lucideServerCog' },
      { label: 'nav.journal', link: '/system/logs', icon: 'lucideScrollText' },
      { label: 'nav.files', link: '/system/files', icon: 'lucideFolderOpen' },
      { label: 'nav.terminal', link: '/system/terminal', icon: 'lucideSquareTerminal' },
    ],
  },
  {
    label: 'nav.settings',
    items: [
      { label: 'nav.notifications', link: '/settings/notifications', icon: 'lucideBellRing' },
    ],
  },
];

export const NAV_ICONS = {
  lucideActivity,
  lucideFolderOpen,
  lucideSquareTerminal,
  lucideLayoutDashboard,
  lucideScrollText,
  lucideBoxes,
  lucideBlocks,
  lucideArchive,
  lucideBell,
  lucideBellRing,
  lucideHardDrive,
  lucideServerCog,
};
