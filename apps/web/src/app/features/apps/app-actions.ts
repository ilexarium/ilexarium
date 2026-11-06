import type { AppState, AppSummary } from '@laris/shared';

/** Something of it is stopped. */
export const canStart = (state: AppState) => state === 'stopped' || state === 'partial';

/** Something of it runs. */
export const canStop = (state: AppState) =>
  state === 'running' || state === 'partial' || state === 'unhealthy';

/** Its web page: this machine's name, its port and path. Plain HTTP (inside your network). */
export function openUrl(app: AppSummary | null, hostname: string): string | null {
  return app?.webPort != null && app.state !== 'none'
    ? `http://${hostname}:${app.webPort}${app.webPath}`
    : null;
}
