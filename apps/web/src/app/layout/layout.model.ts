export interface NavItem {
  /** Translation key. */
  label: string;
  link: string;
  /** Lucide icon name, registered with `provideIcons(NAV_ICONS)`. */
  icon: string;
  /** Active only on this exact URL (for `/`, which every URL starts with). */
  exact?: boolean;
  /** Shows a badge when this part of the app needs attention. */
  attention?: 'backups' | 'alerts' | 'updates';
}

export interface NavGroup {
  /** Translation key; omitted for the top-level group. */
  label?: string;
  items: NavItem[];
}
