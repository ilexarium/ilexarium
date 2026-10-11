export interface NavItem {
  /** Translation key. */
  label: string;
  link: string;
  /** Lucide icon name, registered with `provideIcons(NAV_ICONS)`. */
  icon: string;
  /** Active only on this exact URL (for `/`, which every URL starts with). */
  exact?: boolean;
}

export interface NavGroup {
  /** Translation key; omitted for the top-level group. */
  label?: string;
  items: NavItem[];
}
