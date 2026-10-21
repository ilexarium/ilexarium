import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Alert } from '@laris/shared';
import { testAlert } from '../../core/alerts/testing';
import { AlertsMenu } from './alerts-menu';
import { RESOLVED_IN_MENU } from './alerts-menu.constants';

@Component({
  imports: [AlertsMenu],
  template: `<laris-alerts-menu [open]="open()" [resolved]="resolved()" />`,
})
class Host {
  readonly open = signal<Alert[]>([]);
  readonly resolved = signal<Alert[]>([]);
}

const disk = testAlert({
  kind: 'diskFull',
  subject: '/mnt/usb',
  severity: 'warning',
  catalogId: null,
  serviceName: null,
  percent: 93,
  acknowledgedAt: '2026-10-17T13:00:00.000Z',
  acknowledgedBy: 'owner',
});
const immich = testAlert();
const resolvedBackup = testAlert({
  kind: 'backup',
  subject: 'lastRunFailed',
  severity: 'warning',
  catalogId: null,
  serviceName: null,
  warning: 'lastRunFailed',
  closedAt: '2026-10-18T09:00:00.000Z',
});

describe('AlertsMenu', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()));

  async function render(open: Alert[], resolved: Alert[] = []) {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.open.set(open);
    fixture.componentInstance.resolved.set(resolved);
    await fixture.whenStable();
    const bell = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    const openMenu = async () => {
      bell.click();
      await fixture.whenStable();
      return document.querySelector<HTMLElement>('[data-slot="dropdown-menu"]')!;
    };
    const items = () => [...document.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')];
    return { fixture, bell, openMenu, items };
  }

  it('shows the open count on the bell, red when one is critical', async () => {
    const { bell } = await render([immich, disk]);
    expect(bell.getAttribute('aria-label')).toBe('Alerts: 2 open');
    const badge = bell.querySelector('span')!;
    expect(badge.textContent!.trim()).toBe('2');
    expect(badge.classList).toContain('bg-destructive');
  });

  it('has no count while all is well', async () => {
    const { bell } = await render([]);
    expect(bell.getAttribute('aria-label')).toBe('Alerts');
    expect(bell.querySelector('span')).toBeNull();
  });

  it('lists the open alerts in order, each a link to where it belongs', async () => {
    const { openMenu, items } = await render([immich, disk]);
    const menu = await openMenu();
    expect(menu.textContent).toContain('2 open');
    expect(menu.getAttribute('aria-label')).toBe('Alerts: 2 open');
    const [first, second, all] = items();
    expect(first.textContent).toContain('Immich');
    expect(first.getAttribute('href')).toBe('/containers/hl-immich-server-1/logs');
    expect(second.textContent).toContain('/mnt/usb');
    expect(second.textContent).toContain('Acknowledged');
    expect(second.getAttribute('href')).toBe('/disks');
    expect(all.textContent!.trim()).toBe('All alerts');
    expect(all.getAttribute('href')).toBe('/alerts');
  });

  it('lists the resolved ones below, greyed out, at most a few', async () => {
    const many = Array.from({ length: RESOLVED_IN_MENU + 2 }, () => ({ ...resolvedBackup }));
    many.forEach((alert, i) => (alert.id = `resolved-${i}`));
    const { openMenu, items } = await render([immich], many);
    const menu = await openMenu();
    expect(menu.textContent).toContain('Resolved in the last 7 days');
    const rows = items().slice(0, -1);
    expect(rows).toHaveLength(1 + RESOLVED_IN_MENU);
    const resolved = rows[1];
    expect(resolved.classList).toContain('text-muted-foreground');
    expect(resolved.textContent).toContain('Resolved');
    expect(resolved.getAttribute('href')).toBe('/backups');
  });

  it('says all is well when nothing is open, still with the resolved ones', async () => {
    const { openMenu, items } = await render([], [resolvedBackup]);
    const menu = await openMenu();
    expect(menu.textContent).toContain('All is well: no open alerts.');
    // Not a menu item, so screen readers skip the line: the menu's label says it.
    expect(menu.getAttribute('aria-label')).toBe('All is well: no open alerts.');
    expect(items()).toHaveLength(2);
  });
});

describe('AlertsMenu times', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  it('measures "… ago" again on every update, not only when the menu opened', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-17T12:05:00.000Z'));
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    const first = testAlert({ openedAt: '2026-10-17T12:00:00.000Z' });
    fixture.componentInstance.open.set([first]);
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement).querySelector('button')!.click();
    await fixture.whenStable();
    const menu = () => document.querySelector('[data-slot="dropdown-menu"]')!.textContent!;
    expect(menu()).toContain('5 minutes ago');
    // The menu stays open; an hour later another alert arrives.
    vi.setSystemTime(Date.parse('2026-10-17T13:05:00.000Z'));
    fixture.componentInstance.open.set([
      first,
      testAlert({ openedAt: '2026-10-17T13:04:00.000Z' }),
    ]);
    await fixture.whenStable();
    expect(menu()).toContain('1 hour, 5 minutes ago');
    expect(menu()).toContain('1 minute ago');
  });
});
