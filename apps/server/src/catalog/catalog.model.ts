import type { CatalogMeta } from '@homelab/shared';

/** A loaded, checked catalog entry. */
export interface CatalogEntry {
  meta: CatalogMeta;
  /** Every image its recipe runs (pinned), in recipe order. */
  images: string[];
  /** Its recipe's named Docker volumes. */
  volumes: string[];
  /** The SVG, served only with a no-script Content-Security-Policy and used only in <img>. */
  icon: Buffer;
}
