import type { ResolveFn } from '@angular/router';

/** "Logs · jellyfin" — the top bar and the browser tab. Its own file: the route config imports it. */
export const logsPageTitle: ResolveFn<string> = (route) =>
  `Logs · ${route.paramMap.get('name') ?? ''}`;
