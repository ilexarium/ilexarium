import { describe, expect, it } from 'vitest';
import { appState, appsFromContainers, folderOwner } from './apps.js';
import type { Container } from './monitoring.js';

const container = (over: Partial<Container>): Omit<Container, 'stats'> => ({
  id: over.name ?? 'c',
  name: 'c',
  image: 'x',
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: null,
  composeWorkingDir: null,
  template: null,
  ...over,
});

describe('appsFromContainers', () => {
  it('one app per Compose project, the platform’s own and loose containers left out', () => {
    const apps = appsFromContainers(
      [
        container({
          name: 'navidrome-1',
          composeProject: 'music',
          composeWorkingDir: '/home/anna/apps/music',
          template: 'navidrome@2',
          ports: [{ privatePort: 4533, publicPort: 4600, ip: '0.0.0.0', protocol: 'tcp' }],
        }),
        container({ name: 'db', composeProject: 'music', state: 'exited' }),
        container({ name: 'laris-postgres-1', composeProject: 'laris', protected: true }),
        container({ name: 'loose' }),
      ],
      (id) => (id === 'navidrome' ? { port: 4533, path: '/' } : null),
    );
    expect(apps).toEqual([
      {
        name: 'music',
        folder: '/home/anna/apps/music',
        owner: 'anna',
        template: { id: 'navidrome', version: '2' },
        state: 'partial',
        containers: ['db', 'navidrome-1'],
        webPort: 4600,
        webPath: '/',
      },
    ]);
  });

  it('without a template: the first TCP port published beyond loopback', () => {
    const [app] = appsFromContainers([
      container({
        composeProject: 'x',
        ports: [
          { privatePort: 11434, publicPort: 11434, ip: '127.0.0.1', protocol: 'tcp' },
          { privatePort: 80, publicPort: 8080, ip: '0.0.0.0', protocol: 'tcp' },
        ],
      }),
    ]);
    expect(app.webPort).toBe(8080);
  });
});

describe('appState', () => {
  it('none, unhealthy, stopped, partial, running', () => {
    expect(appState([])).toBe('none');
    expect(appState([{ state: 'running', health: 'unhealthy' }])).toBe('unhealthy');
    expect(appState([{ state: 'exited', health: 'none' }])).toBe('stopped');
    expect(
      appState([
        { state: 'running', health: 'none' },
        { state: 'exited', health: 'none' },
      ]),
    ).toBe('partial');
    expect(appState([{ state: 'running', health: 'healthy' }])).toBe('running');
  });
});

describe('folderOwner', () => {
  it('the account whose home it is in', () => {
    expect(folderOwner('/home/anna/apps/x')).toBe('anna');
    expect(folderOwner('/srv/x')).toBeNull();
    expect(folderOwner(null)).toBeNull();
  });
});
