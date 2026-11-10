import type { Alert, AlertsStatus } from '@ilex/shared';

let next = 0;

/** An open "service down" alert of Immich, changed as needed. */
export function testAlert(change: Partial<Alert> = {}): Alert {
  next++;
  return {
    id: `0199f000-0000-7000-8000-${String(next).padStart(12, '0')}`,
    kind: 'serviceDown',
    subject: 'hl-immich-server-1',
    severity: 'critical',
    app: 'immich',
    percent: null,
    warning: null,
    openedAt: '2026-10-17T12:00:00.000Z',
    closedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...change,
  };
}

export function alertsStatus(change: Partial<AlertsStatus> = {}): AlertsStatus {
  return { open: [], closed: [], deliveryFailure: null, ...change };
}
