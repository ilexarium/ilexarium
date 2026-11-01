import type { Container } from '@laris/shared';
import { groupByApp, needsAttention } from './container-groups';

const container = (name: string, more: Partial<Container> = {}): Container => ({
  id: name,
  name,
  image: 'some/image:1',
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: null,
  composeWorkingDir: null,
  template: null,
  stats: null,
  ...more,
});

const groups = (containers: Container[]) =>
  groupByApp(containers).map((g) => ({
    app: g.app?.name ?? null,
    containers: g.containers.map((c) => c.name),
    running: g.running,
  }));

describe('needsAttention', () => {
  it('is unhealthy, restarting or dead — not a plain stop', () => {
    expect(needsAttention({ state: 'running', health: 'unhealthy' })).toBe(true);
    expect(needsAttention({ state: 'restarting', health: 'none' })).toBe(true);
    expect(needsAttention({ state: 'dead', health: 'none' })).toBe(true);
    expect(needsAttention({ state: 'exited', health: 'none' })).toBe(false);
    expect(needsAttention({ state: 'running', health: 'starting' })).toBe(false);
  });
});

describe('groupByApp', () => {
  it('groups by app, sorted by name, the containers of no app last', () => {
    expect(
      groups([
        container('solo'),
        container('wiki-db', { composeProject: 'wiki', state: 'exited' }),
        container('photos', { composeProject: 'photos' }),
        container('wiki', { composeProject: 'wiki' }),
      ]),
    ).toEqual([
      { app: 'photos', containers: ['photos'], running: 1 },
      { app: 'wiki', containers: ['wiki', 'wiki-db'], running: 1 },
      { app: null, containers: ['solo'], running: 1 },
    ]);
  });

  it('keeps apps in name order whatever their state (rows never move under the pointer)', () => {
    const result = groups([
      container('a', { composeProject: 'alpha' }),
      container('z', { composeProject: 'zulu', health: 'unhealthy' }),
    ]);
    expect(result.map((g) => g.app)).toEqual(['alpha', 'zulu']);
  });

  it("counts the platform's own Compose project as no app, like the Apps page", () => {
    const result = groups([
      container('laris-postgres', { composeProject: 'laris', protected: true }),
      container('laris-proxy', { composeProject: 'laris' }),
    ]);
    expect(result).toEqual([
      { app: null, containers: ['laris-postgres', 'laris-proxy'], running: 2 },
    ]);
  });

  it("knows an app's template from its label", () => {
    const [group] = groupByApp([
      container('jellyfin', { composeProject: 'media', template: 'jellyfin@3' }),
    ]);
    expect(group.app).toEqual({ name: 'media', templateId: 'jellyfin' });
  });
});
