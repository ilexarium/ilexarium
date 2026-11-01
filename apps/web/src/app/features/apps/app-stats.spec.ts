import type { Container, ContainerHistoryPoint } from '@laris/shared';
import { appStats, appTrends, shortFolder } from './app-stats';

const container = (id: string, change: Partial<Container> = {}): Container => ({
  id,
  name: id,
  image: 'example/x:1',
  state: 'running',
  health: 'none',
  startedAt: null,
  ports: [],
  protected: false,
  composeProject: 'notes',
  composeWorkingDir: null,
  template: null,
  stats: {
    at: 3,
    cpuPercent: 10,
    memoryUsedBytes: 100,
    memoryLimitBytes: 1000,
    netRxBytes: 0,
    netTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
  },
  ...change,
});

const points = (...values: [number, number][]): ContainerHistoryPoint[] =>
  values.map(([cpuPercent, memoryUsedBytes], at) => ({ at, cpuPercent, memoryUsedBytes }));

describe('appStats', () => {
  it('sums the running containers now, and their lines from the newest point back', () => {
    const stats = appStats([container('web'), container('db')], {
      web: points([1, 10], [2, 20], [3, 30]),
      // Started later: nothing before its first point.
      db: points([5, 50], [6, 60]),
    });
    expect(stats).toEqual({
      cpuPercent: 20,
      memoryUsedBytes: 200,
      cpuHistory: [1, 7, 9],
      memoryHistory: [10, 70, 90],
    });
  });

  it('leaves out a stopped container, and is null with none running or no stats yet', () => {
    const stopped = container('db', { state: 'exited', stats: null });
    expect(appStats([container('web'), stopped], {})!.cpuPercent).toBe(10);
    expect(appStats([stopped], {})).toBeNull();
    expect(appStats([container('web', { stats: null })], {})).toBeNull();
    expect(appStats([], {})).toBeNull();
  });
});

describe('appTrends', () => {
  it('draws lines from two points on, the CPU line with a floor for its top', () => {
    const stats = { cpuPercent: 1, memoryUsedBytes: 5, cpuHistory: [1, 2], memoryHistory: [4, 5] };
    const trends = appTrends(stats);
    expect(trends.cpu!.max).toBe(10);
    expect(trends.cpu!.series[0].values).toEqual([1, 2]);
    expect(trends.memory![0].values).toEqual([4, 5]);
    expect(appTrends({ ...stats, cpuHistory: [1], memoryHistory: [4] })).toEqual({
      cpu: null,
      memory: null,
    });
    expect(appTrends(null)).toEqual({ cpu: null, memory: null });
  });
});

describe('shortFolder', () => {
  it('writes the owner’s home as ~, and leaves any other folder as it is', () => {
    expect(shortFolder('/home/anna/apps/notes', 'anna')).toBe('~/apps/notes');
    expect(shortFolder('/home/annabel/apps/notes', 'anna')).toBe('/home/annabel/apps/notes');
    expect(shortFolder('/srv/notes', 'anna')).toBe('/srv/notes');
    expect(shortFolder('/home/anna/apps/notes', null)).toBe('/home/anna/apps/notes');
  });
});
