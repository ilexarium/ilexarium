import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AlertsStatus } from '@ilex/shared';
import { toast } from '@spartan-ng/brain/sonner';
import { NEVER, of, throwError } from 'rxjs';
import { AlertsApi } from '../../../core/alerts/alerts-api';
import { AlertsStore } from '../../../core/alerts/alerts-store';
import { alertsStatus, testAlert } from '../../../core/alerts/testing';
import { AuthStore } from '../../../core/auth/auth-store';
import { fakeAuthApi, OWNER } from '../../../core/auth/testing';
import { AlertsPage } from './alerts-page';

async function render(start: AlertsStatus | null) {
  const auth = fakeAuthApi({ user: OWNER });
  const api = {
    status: vi.fn(() => of(start ?? alertsStatus())),
    acknowledge: vi.fn(() => of(undefined)),
  };
  TestBed.configureTestingModule({
    providers: [provideRouter([]), auth.provider, { provide: AlertsApi, useValue: api }],
  });
  await TestBed.inject(AuthStore).load();
  if (start) TestBed.inject(AlertsStore).fill(start);
  else api.status.mockReturnValue(NEVER); // never answers
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
            app: null,
            percent: 93,
          }),
        ],
        closed: [
          testAlert({
            kind: 'backup',
            subject: 'lastRunFailed',
            app: null,
            warning: 'lastRunFailed',
            closedAt: '2026-10-17T13:00:00.000Z',
          }),
        ],
      }),
    );
    const open = section('alerts-open');
    const cards = open.querySelectorAll('ilex-alert-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('immich has stopped');
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

  it('says in one line what is open, the notification settings beside it', async () => {
    const headline = async (open: Parameters<typeof alertsStatus>[0]) => {
      TestBed.resetTestingModule();
      const { el } = await render(alertsStatus(open));
      return el;
    };
    let el = await headline({
      open: [testAlert(), testAlert({ severity: 'warning' }), testAlert({ severity: 'warning' })],
    });
    expect(el.querySelector('[data-headline]')!.textContent!.trim()).toBe(
      '1 critical alert, 2 warnings',
    );
    // At the top, before the lists however long they are.
    const settings = el.querySelector<HTMLAnchorElement>('a[href="/settings/notifications"]')!;
    expect(settings.textContent).toContain('Notification settings');
    expect(
      settings.compareDocumentPosition(el.querySelector('#alerts-open')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    el = await headline({ open: [testAlert({ severity: 'warning' })] });
    expect(el.querySelector('[data-headline]')!.textContent!.trim()).toBe('1 warning');
    el = await headline({});
    expect(el.querySelector('[data-headline]')!.textContent!.trim()).toBe(
      'All is well: no open alerts.',
    );
  });

  it('names the container below an app’s alert, not again below a disk’s or a container’s', async () => {
    const { el } = await render(
      alertsStatus({
        open: [
          testAlert(),
          testAlert({ subject: 'hl-redis-1', app: null }),
          testAlert({ kind: 'diskFull', subject: '/mnt/usb', app: null, percent: 93 }),
        ],
      }),
    );
    const meta = [...el.querySelectorAll('ilex-alert-card')].map(
      (c) => c.querySelectorAll('p')[1].textContent!,
    );
    expect(meta[0]).toContain('hl-immich-server-1');
    expect(meta[0]).toMatch(/^\s*For /);
    expect(meta[1]).not.toContain('hl-redis-1');
    expect(meta[2]).not.toContain('/mnt/usb');
  });

  it('links an open full disk to freeing Docker’s unused data too', async () => {
    const { el } = await render(
      alertsStatus({
        open: [testAlert(), testAlert({ kind: 'diskFull', subject: '/', app: null, percent: 93 })],
      }),
    );
    const links = [...el.querySelectorAll('ilex-alert-card')].map((card) =>
      [...card.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    );
    expect(links[0]).toEqual([expect.stringContaining('/logs')]);
    expect(links[1]).toEqual(['/disks', '/containers#free-space']);
  });

  it('lists resolved alerts as quiet rows: how long they lasted, when they ended', async () => {
    const { section } = await render(
      alertsStatus({
        closed: [
          testAlert({
            kind: 'restartLoop',
            subject: 'hl-navidrome-1',
            app: null,
            openedAt: '2026-10-17T12:00:00.000Z',
            closedAt: '2026-10-17T12:20:00.000Z',
          }),
        ],
      }),
    );
    const row = section('alerts-closed').querySelector('ilex-alert-row')!;
    expect(row.textContent).toContain('hl-navidrome-1 keeps restarting');
    expect(row.textContent).toContain('Lasted 20 minutes · ended');
    expect(row.querySelector('ilex-alert-card, a, button')).toBeNull();
  });

  it('says so when all is well', async () => {
    const { section } = await render(alertsStatus());
    expect(section('alerts-open').textContent).toContain('no open alerts');
    expect(section('alerts-closed').textContent).toContain('Nothing in the last 7 days.');
  });

  it('acknowledges an alert, and shows who did at once', async () => {
    const alert = testAlert();
    const other = testAlert({ subject: 'hl-jellyfin-1', app: 'jellyfin' });
    const { fixture, el, api } = await render(alertsStatus({ open: [alert, other] }));
    api.status.mockClear();
    const card = (name: string) =>
      [...el.querySelectorAll('ilex-alert-card')].find((c) => c.textContent!.includes(name))!;
    card('immich has')
      .querySelectorAll('button')
      .forEach((b) => b.textContent!.includes('Acknowledge') && b.click());
    await fixture.whenStable();
    expect(api.acknowledge).toHaveBeenCalledWith(alert.id);
    // Shown from here; no second request whose older answer could undo the topic's news.
    expect(api.status).not.toHaveBeenCalled();
    expect(card('immich has').textContent).toContain('Acknowledged by owner');
    expect(card('immich has').querySelector('button')).toBeNull();
    expect(card('jellyfin has').textContent).toContain('Acknowledge');
  });

  it('a late answer of its first load doesn’t replace what the topic said meanwhile', async () => {
    const { fixture, el, api } = await render(null);
    const store = TestBed.inject(AlertsStore);
    store.fill(alertsStatus({ open: [testAlert()] })); // the topic
    store.fill(alertsStatus()); // the slower HTTP answer
    await fixture.whenStable();
    expect(api.status).toHaveBeenCalled();
    expect(el.textContent).toContain('immich has stopped');
  });

  it('reports a failed acknowledgement in a toast', async () => {
    const alert = testAlert();
    const { fixture, el, api } = await render(alertsStatus({ open: [alert] }));
    api.acknowledge.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({ status: 404, error: { message: 'x', code: 'alert_not_found' } }),
      ),
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
