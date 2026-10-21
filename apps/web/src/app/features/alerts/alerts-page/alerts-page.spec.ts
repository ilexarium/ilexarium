import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AlertsStatus } from '@laris/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { AlertsApi } from '../../../core/alerts/alerts-api';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { alertsStatus, testAlert } from '../../../core/alerts/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { AlertsPage } from './alerts-page';

async function render(start: AlertsStatus | null) {
  const auth = fakeAuthApi({ user: OWNER });
  const api = {
    status: vi.fn(async () => start ?? alertsStatus()),
    acknowledge: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), auth.provider, { provide: AlertsApi, useValue: api }],
  });
  await TestBed.inject(AuthStore).load();
  if (start) TestBed.inject(AlertsStore).fill(start);
  else api.status.mockReturnValue(new Promise(() => undefined)); // never answers
  const fixture = TestBed.createComponent(AlertsPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const section = (id: string) => el.querySelector(`section[aria-labelledby="${id}"]`)!;
  return { fixture, el, api, section };
}

describe('AlertsPage', () => {
  it('shows a loading state until the alerts are known', async () => {
    const { el } = await render(null);
    expect(el.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe('Loading alerts');
  });

  it('lists open alerts with what to do and where to look, then resolved ones', async () => {
    const { section } = await render(
      alertsStatus({
        open: [
          testAlert(),
          testAlert({
            kind: 'diskFull',
            subject: '/mnt/usb',
            severity: 'warning',
            catalogId: null,
            serviceName: null,
            percent: 93,
          }),
        ],
        closed: [
          testAlert({
            kind: 'backup',
            subject: 'lastRunFailed',
            catalogId: null,
            serviceName: null,
            warning: 'lastRunFailed',
            closedAt: '2026-10-17T13:00:00.000Z',
          }),
        ],
      }),
    );
    const open = section('alerts-open');
    const cards = open.querySelectorAll('laris-alert-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Immich has stopped');
    expect(cards[0].textContent).toContain('Critical');
    expect(cards[0].textContent).toContain('It stopped by itself.');
    expect(cards[0].querySelector('a')!.getAttribute('href')).toBe(
      '/containers/hl-immich-server-1/logs',
    );
    expect(cards[1].textContent).toContain('Disk /mnt/usb is 93% full');
    expect(cards[1].querySelector('a')!.getAttribute('href')).toBe('/disks');

    const closed = section('alerts-closed');
    expect(closed.textContent).toContain('The last backup failed');
    expect(closed.querySelector('button')).toBeNull();
  });

  it('says so when all is well', async () => {
    const { section } = await render(alertsStatus());
    expect(section('alerts-open').textContent).toContain('no open alerts');
    expect(section('alerts-closed').textContent).toContain('Nothing in the last 7 days.');
  });

  it('acknowledges an alert, and shows who did at once', async () => {
    const alert = testAlert();
    const other = testAlert({ subject: 'hl-jellyfin-1', serviceName: 'Jellyfin' });
    const { fixture, el, api } = await render(alertsStatus({ open: [alert, other] }));
    api.status.mockClear();
    const card = (name: string) =>
      [...el.querySelectorAll('laris-alert-card')].find((c) => c.textContent!.includes(name))!;
    card('Immich')
      .querySelectorAll('button')
      .forEach((b) => b.textContent!.includes('Acknowledge') && b.click());
    await fixture.whenStable();
    expect(api.acknowledge).toHaveBeenCalledWith(alert.id);
    // Shown from here; no second request whose older answer could undo the topic's news.
    expect(api.status).not.toHaveBeenCalled();
    expect(card('Immich').textContent).toContain('Acknowledged by owner');
    expect(card('Immich').querySelector('button')).toBeNull();
    expect(card('Jellyfin').textContent).toContain('Acknowledge');
  });

  it('a late answer of its first load doesn’t replace what the topic said meanwhile', async () => {
    const { fixture, el, api } = await render(null);
    const store = TestBed.inject(AlertsStore);
    store.fill(alertsStatus({ open: [testAlert()] })); // the topic
    store.fill(alertsStatus()); // the slower HTTP answer
    await fixture.whenStable();
    expect(api.status).toHaveBeenCalled();
    expect(el.textContent).toContain('Immich has stopped');
  });

  it('reports a failed acknowledgement in a toast', async () => {
    const alert = testAlert();
    const { fixture, el, api } = await render(alertsStatus({ open: [alert] }));
    api.acknowledge.mockRejectedValue(
      new HttpErrorResponse({ status: 404, error: { message: 'x', code: 'alert_not_found' } }),
    );
    const error = vi.spyOn(toast, 'error');
    [...el.querySelectorAll('button')].find((b) => b.textContent!.includes('Acknowledge'))!.click();
    await fixture.whenStable();
    expect(error).toHaveBeenCalledWith("The alert couldn't be acknowledged", {
      description: "This alert isn't open any more.",
    });
  });

  it('shows when a message couldn’t be sent, with a way to the settings', async () => {
    const { el } = await render(
      alertsStatus({
        deliveryFailure: {
          channel: 'email',
          at: '2026-10-17T12:02:00.000Z',
          problem: 'loginRefused',
        },
      }),
    );
    const notice = el.querySelector('[role="alert"]')!;
    expect(notice.textContent).toContain("A message couldn't be sent");
    expect(notice.textContent).toContain('The last message by email couldn');
    expect(notice.textContent).toContain('The server refused the login.');
    expect(notice.querySelector('a')!.getAttribute('href')).toBe('/settings/notifications');
  });
});
