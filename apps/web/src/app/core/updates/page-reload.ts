import { DOCUMENT, inject, InjectionToken } from '@angular/core';

/** Reloads the page (a token, so tests see it without reloading theirs). */
export const PAGE_RELOAD = new InjectionToken<() => void>('PAGE_RELOAD', {
  factory: () => {
    const document = inject(DOCUMENT);
    return () => document.location.reload();
  },
});
