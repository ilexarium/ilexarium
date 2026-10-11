import { TestBed } from '@angular/core/testing';
import type { Container, ContainersSnapshot } from '@homelab/shared';
import { ContainersTable } from './containers-table';

const NOW = Date.parse('2026-10-11T15:00:00Z');

const web: Container = {
  id: 'a1',
  name: 'jellyfin',
  image: 'jellyfin/jellyfin:10.11',
  state: 'running',
  health: 'healthy',
  startedAt: '2026-10-11T12:00:00Z',
  ports: [
    { privatePort: 8096, publicPort: 8096, ip: '0.0.0.0', protocol: 'tcp' },
    { privatePort: 1900, protocol: 'udp' },
  ],
  stats: {
    at: NOW,
    cpuPercent: 12.4,
    memoryUsedBytes: 512_000_000,
    memoryLimitBytes: 8_000_000_000,
    netRxBytes: 2_000_000,
    netTxBytes: 1_000_000,
    blockReadBytes: 3_000_000,
    blockWriteBytes: 4_000_000,
  },
};
const stopped: Container = {
  ...web,
  id: 'b2',
  name: 'old-app',
  state: 'exited',
  health: 'none',
  startedAt: null,
  ports: [],
  stats: null,
};
const sick: Container = { ...web, id: 'c3', name: 'db', health: 'unhealthy' };

async function render(containers: ContainersSnapshot | null) {
  const fixture = TestBed.createComponent(ContainersTable);
  fixture.componentRef.setInput('containers', containers);
  fixture.componentRef.setInput('now', NOW);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    el,
    /** Per row, the text of each cell (screen readers announce cells one by one). */
    tableRows: () =>
      [...el.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('th, td')].map((cell) =>
          cell.textContent!.replace(/\s+/g, ' ').trim(),
        ),
      ),
    cards: () => [...el.querySelectorAll('ul > li')],
  };
}

const snapshot = (...containers: Container[]): ContainersSnapshot => ({
  dockerAvailable: true,
  containers,
  history: {},
});

describe('ContainersTable', () => {
  it('shows each container with state, health and live resource use', async () => {
    const { tableRows } = await render(snapshot(web));
    expect(tableRows()).toEqual([
      [
        'jellyfin, jellyfin/jellyfin:10.11',
        'Running Healthy',
        '12%',
        '512 MB / 8.0 GB',
        '2.0 MB in, 1.0 MB out',
        '3.0 MB read, 4.0 MB written',
        '3 hours',
        '8096 → 8096/tcp, 1900/udp',
      ],
    ]);
  });

  it('shows dashes for a stopped container instead of stats and uptime', async () => {
    const { tableRows } = await render(snapshot(stopped));
    expect(tableRows()[0]).toEqual([
      'old-app, jellyfin/jellyfin:10.11',
      'Stopped',
      '—',
      '—',
      '—',
      '—',
      '—',
      '—',
    ]);
  });

  it('flags an unhealthy container in words', async () => {
    const { el } = await render(snapshot(sick));
    const badge = el.querySelector('tbody [hlmBadge]')!;
    expect(badge.textContent!.trim()).toBe('Unhealthy');
    expect(badge.className).toContain('destructive');
  });

  it('summarises how many are running', async () => {
    const { el } = await render(snapshot(web, stopped, sick));
    expect(el.querySelector('[hlmCardDescription]')!.textContent).toContain('2 of 3 running');
  });

  it('has a card per container for phones and tablets, and a table for large screens', async () => {
    const { el, cards } = await render(snapshot(web, stopped));
    expect(el.querySelector('[hlmTableContainer]')!.className).toContain('hidden lg:block');
    expect(el.querySelector('ul')!.className).toContain('lg:hidden');
    expect(cards()).toHaveLength(2);
    const card = cards()[0];
    expect(card.textContent).toContain('jellyfin');
    const terms = [...card.querySelectorAll('dt')].map((dt) => dt.textContent!.trim());
    expect(terms).toEqual(['CPU', 'Memory', 'Up for', 'Network', 'Disk I/O', 'Ports']);
  });

  it('explains when Docker is not reachable, as an alert', async () => {
    const { el } = await render({ dockerAvailable: false });
    const alert = el.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Docker isn't reachable");
    expect(alert.textContent).toContain('keep working');
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('[hlmCardDescription]')!.textContent).toContain('Docker not reachable');
  });

  it('says so when there are no containers, and shows a loading state before data', async () => {
    expect((await render(snapshot())).el.textContent).toContain('No containers yet.');
    const loading = await render(null);
    expect(loading.el.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe(
      'Loading containers',
    );
  });
});
