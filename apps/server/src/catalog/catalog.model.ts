import type { Template } from '@laris/shared';

/** A loaded, checked template. */
export interface CatalogEntry {
  template: Template;
  /** Its compose.yml as written (comments kept: it becomes the app's own file). */
  compose: string;
  /** The SVG, served only with a no-script Content-Security-Policy and used only in <img>. */
  icon: Buffer;
}
