import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type {
  Container,
  ContainerAction,
  ContainersSnapshot,
  ContainerActionParams,
} from '@ilex/shared';
import { groupByApp } from '../container-groups';
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
  protected: false,
  composeProject: null,
  composeWorkingDir: null,
  template: null,
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
  // As the page's store groups them.
  fixture.componentRef.setInput(
    'groups',
    containers?.dockerAvailable ? groupByApp(containers.containers) : [],
  );
  // What the table reports: the page's store runs it.
  const emitted: ContainerActionParams[] = [];
  fixture.componentInstance.action.subscribe((request) => emitted.push(request));
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    emitted,
    /** The page store's pending actions, as the page passes them in. */
    setPending: async (pending: [string, ContainerAction][]) => {
      fixture.componentRef.setInput('pending', new Map(pending));
      await fixture.whenStable();
    },
    /** Per row, the text of each cell (screen readers announce cells one by one). */
    tableRows: () =>
      [...el.querySelectorAll('tbody tr:not(:has([scope="rowgroup"]))')].map((tr) =>
        [...tr.querySelectorAll('th, td')].map((cell) =>
          cell.textContent!.replace(/\s+/g, ' ').trim(),
        ),
      ),
    cards: () => [...el.querySelectorAll('ul > li')],
  };
}

type Listed = Extract<ContainersSnapshot, { dockerAvailable: true }>;

const snapshot = (...containers: Container[]): Listed => ({
  dockerAvailable: true,
  containers,
  history: {},
});

/** Two chart points for each container. */
const withHistory = (...containers: Container[]): Listed => ({
  ...snapshot(...containers),
  history: Object.fromEntries(
    containers.map((c) => [
      c.id,
      [
        { at: NOW - 2000, cpuPercent: 1, memoryUsedBytes: 100 },
        { at: NOW, cpuPercent: 2, memoryUsedBytes: 120 },
      ],
    ]),
  ),
});

const ENTER = { key: 'Enter', keyCode: 13, bubbles: true } as KeyboardEventInit;

describe('ContainersTable', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([{ path: '**', children: [] }])] });
  });

  it('shows each container with state, health and live resource use', async () => {
    const { tableRows } = await render(snapshot(web));
    expect(tableRows()).toEqual([
      [
        'jellyfin, jellyfin/jellyfin:10.11',
        'Running Healthy',
        '12%',
        '512 MB of 8.0 GB',
        '2.0 MB in 1.0 MB out',
        '3.0 MB read 4.0 MB written',
        '3 hours',
        '8096 → 8096/tcp 1900/udp',
        '', // the actions button: named by its aria-label
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
      '',
    ]);
  });

  it('times uptimes by the newest stats frame', async () => {
    const { tableRows } = await render(snapshot(web, stopped));
    expect(tableRows()[0][6]).toBe('3 hours');
  });

  describe('actions', () => {
    afterEach(() =>
      document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove()),
    );

    it('has an actions button per container, named for it, in the table and the cards', async () => {
      const { el, cards } = await render(snapshot(web, stopped));
      const inTable = [...el.querySelectorAll('tbody button')].map((b) =>
        b.getAttribute('aria-label'),
      );
      expect(inTable).toEqual(['Actions for jellyfin', 'Actions for old-app']);
      for (const [i, card] of cards().entries()) {
        expect(card.querySelector('button')!.getAttribute('aria-label')).toBe(inTable[i]);
      }
      expect(el.querySelector('thead th:last-child')!.textContent!.trim()).toBe('Actions');
    });

    it('opens a menu whose View logs goes to the container’s logs page', async () => {
      const { el } = await render(snapshot(web, stopped));
      const trigger = el.querySelectorAll<HTMLButtonElement>('tbody button')[1];
      trigger.click();
      await TestBed.inject(Router).navigated; // let the menu render
      const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      expect(items.map((item) => item.textContent!.trim())).toEqual(['View logs', 'Start']);
      items[0].click();
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/containers/old-app/logs'));
    });

    it('works from the keyboard: Enter opens the menu at its first item, Enter picks it', async () => {
      const { fixture, cards } = await render(snapshot(web));
      const trigger = cards()[0].querySelector<HTMLButtonElement>('button')!; // phone card
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent('keydown', ENTER));
      await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'));
      await fixture.whenStable();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', ENTER));
      await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/containers/jellyfin/logs'));
    });

    /** Opens a row's menu (table) and returns its items' texts and elements. */
    async function openMenu(el: HTMLElement, row: number) {
      el.querySelectorAll<HTMLButtonElement>('tbody button')[row].click();
      await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
      const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      return { items, texts: items.map((item) => item.textContent!.trim()) };
    }

    /** Closes the open menu the way a user would. */
    async function closeMenu() {
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).toBeNull());
    }

    const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
    const dialogButton = (text: string) =>
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent!.trim() === text,
      )!;

    it('offers what fits the state, and nothing but the logs for a protected container', async () => {
      const paused: Container = { ...web, id: 'p', name: 'paused-app', state: 'paused' };
      const created: Container = { ...stopped, id: 'n', name: 'new-app', state: 'created' };
      const platform: Container = { ...web, id: 'pg', name: 'postgres', protected: true };
      const { el } = await render(snapshot(web, stopped, created, paused, platform));
      const expected = [
        ['View logs', 'Stop', 'Restart'],
        ['View logs', 'Start'],
        ['View logs', 'Start'],
        ['View logs'],
        ['View logs'],
      ];
      for (const [row, texts] of expected.entries()) {
        expect((await openMenu(el, row)).texts, `row ${row}`).toEqual(texts);
        await closeMenu();
      }
    });

    it('reports a start at once, without asking', async () => {
      const { el, emitted } = await render(snapshot(stopped));
      (await openMenu(el, 0)).items[1].click();
      await vi.waitFor(() => expect(emitted).toEqual([{ name: 'old-app', action: 'start' }]));
      expect(dialog()).toBeNull();
    });

    it('asks before stopping; cancelling reports nothing', async () => {
      const { el, emitted } = await render(snapshot(web));
      (await openMenu(el, 0)).items[1].click();
      await vi.waitFor(() => expect(dialog()).not.toBeNull());
      expect(dialog()!.textContent).toContain('Stop jellyfin?');
      expect(dialog()!.textContent).toContain('It will be unreachable until you start it again.');
      // The name stays left to right in right-to-left languages.
      expect(dialog()!.querySelector('h2 [dir="ltr"]')!.textContent).toBe('jellyfin');
      dialogButton('Cancel').click();
      await vi.waitFor(() => expect(dialog()).toBeNull());
      expect(emitted).toEqual([]);
    });

    it('reports a stop after confirmation', async () => {
      const { fixture, el, emitted } = await render(snapshot(web));
      (await openMenu(el, 0)).items[1].click();
      await vi.waitFor(() => expect(dialog()).not.toBeNull());
      dialogButton('Stop').click();
      await fixture.whenStable();
      expect(emitted).toEqual([{ name: 'jellyfin', action: 'stop' }]);
    });

    it('shows a pending action, in the table and the cards, and offers nothing else meanwhile', async () => {
      const { el, tableRows, cards, setPending } = await render(snapshot(web));
      await setPending([['jellyfin', 'stop']]);
      expect(tableRows()[0][1]).toBe('Stopping… Healthy');
      expect(cards()[0].textContent).toContain('Stopping…');
      expect((await openMenu(el, 0)).texts).toEqual(['View logs']);
      await closeMenu();
      await setPending([]);
      expect(tableRows()[0][1]).toBe('Running Healthy'); // until the topic says otherwise
    });

    it('asks before restarting, from the keyboard too', async () => {
      const { el, emitted } = await render(snapshot(web));
      (await openMenu(el, 0)).items[2].click();
      await vi.waitFor(() => expect(dialog()).not.toBeNull());
      expect(dialog()!.textContent).toContain('Restart jellyfin?');
      // Focus moves into the dialog; Escape closes it without acting.
      await vi.waitFor(() => expect(dialog()!.contains(document.activeElement)).toBe(true));
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await vi.waitFor(() => expect(dialog()).toBeNull());
      expect(emitted).toEqual([]);
    });
  });

  it('keeps names, images and ports left to right, in the table and the cards', async () => {
    const { el, cards } = await render(snapshot(web));
    const ltr = (root: Element) =>
      [...root.querySelectorAll('[dir="ltr"]')].map((node) => node.textContent!.trim());
    expect(ltr(el.querySelector('tbody')!)).toEqual([
      'jellyfin,',
      'jellyfin/jellyfin:10.11',
      '8096 → 8096/tcp 1900/udp',
    ]);
    expect(ltr(cards()[0])).toEqual([
      'jellyfin,',
      'jellyfin/jellyfin:10.11',
      '8096 → 8096/tcp 1900/udp',
    ]);
  });

  it('flags an unhealthy container in words', async () => {
    const { el } = await render(snapshot(sick));
    const badge = el.querySelector('tbody ilex-status-badge')!;
    expect(badge.textContent!.trim()).toBe('Unhealthy');
    expect(badge.getAttribute('data-tone')).toBe('failed');
  });

  describe('groups', () => {
    const photos: Container = {
      ...web,
      id: 'p1',
      name: 'immich',
      composeProject: 'photos',
      template: 'immich@2',
    };
    const photosDb: Container = {
      ...stopped,
      id: 'p2',
      name: 'immich-db',
      composeProject: 'photos',
    };
    const wiki: Container = { ...web, id: 'w1', name: 'wiki', composeProject: 'wiki' };

    const headings = (root: Element) =>
      [...root.querySelectorAll('[scope="rowgroup"], h3')].map((h) =>
        h.textContent!.replace(/\s+/g, ' ').trim(),
      );

    it('puts each app under a heading with its icon, a link to it and how many run; the rest last', async () => {
      const { el } = await render(snapshot(web, wiki, photosDb, photos));
      expect(headings(el.querySelector('table')!)).toEqual([
        'photos, 1 of 2 running',
        'wiki, 1 of 1 running',
        'Other containers, 1 of 1 running',
      ]);
      expect(headings(el.querySelector('.xl\\:hidden')!)).toEqual(
        headings(el.querySelector('table')!),
      );
      const links = [...el.querySelectorAll('table [scope="rowgroup"] a')];
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['/apps/photos', '/apps/wiki']);
      expect(el.querySelector('table [scope="rowgroup"] img')!.getAttribute('src')).toBe(
        '/api/catalog/immich/icon',
      );
      // An app's containers by name, under its heading.
      expect(
        [...el.querySelectorAll('table tbody')[0].querySelectorAll('tr th[scope="row"]')].map(
          (th) => th.textContent!.split(',')[0].trim(),
        ),
      ).toEqual(['immich', 'immich-db']);
    });
  });

  it('draws recent CPU and memory beside the values of running containers only', async () => {
    const { el, cards } = await render(withHistory(web, stopped));
    const [running, idle] = el.querySelectorAll('tbody tr:not(:has([scope="rowgroup"]))');
    expect(running.querySelectorAll('ilex-sparkline')).toHaveLength(2);
    expect(idle.querySelectorAll('ilex-sparkline')).toHaveLength(0);
    expect(cards()[0].querySelectorAll('ilex-sparkline')).toHaveLength(2);
    expect(running.querySelector('ilex-sparkline')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws no line from a single point', async () => {
    const one = withHistory(web);
    const { el } = await render({ ...one, history: { a1: one.history['a1'].slice(1) } });
    expect(el.querySelector('ilex-sparkline')).toBeNull();
  });

  it('pulses the dot of a running container (with motion allowed), not a stopped or unhealthy one', async () => {
    const { el } = await render(snapshot(web, stopped, sick));
    const dots = [...el.querySelectorAll('tbody tr [aria-hidden="true"].rounded-full')].map(
      (dot) => dot.className,
    );
    // By name: db (unhealthy), jellyfin, old-app.
    expect(dots[0]).toContain('text-light-fail');
    expect(dots[0]).not.toContain('animate-light-pulse');
    expect(dots[1]).toContain('text-light-ok');
    expect(dots[1]).toContain('motion-safe:animate-light-pulse');
    expect(dots[2]).not.toContain('animate-light-pulse');
  });

  it('has a card per container below extra-large screens, and a table from there up', async () => {
    const { el, cards } = await render(snapshot(web, stopped));
    expect(el.querySelector('[hlmTableContainer]')!.className).toContain('hidden xl:block');
    expect(el.querySelector('.xl\\:hidden ul')).not.toBeNull();
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
    expect(alert.textContent).toContain('Make sure Docker is running');
    expect(el.querySelector('table')).toBeNull();
  });

  it('says so when there are no containers, and shows a loading state before data', async () => {
    expect((await render(snapshot())).el.textContent).toContain('No containers yet.');
    const loading = await render(null);
    expect(loading.el.querySelector('[role="status"]')!.getAttribute('aria-label')).toBe(
      'Loading containers',
    );
  });
});
