import type {
  Alert,
  BackupRun,
  BackupsStatus,
  Container,
  DiskUsage,
  InstalledService,
} from '@laris/shared';
import { serviceContainers } from '../../../core/services/service-runtimes';
import type { ServiceRuntime } from '../../../core/services/services.model';
import type { Wording } from '../../../core/alerts/alert-wording';
import { percentOf } from '../../../shared/format/format';
import {
  APP_ALERT_KINDS,
  ASSISTANT_CATALOG_ID,
  BACKUP_DAYS,
  BACKUP_OUTCOME_RANK,
  DISK_WARN_PERCENT,
  HIDDEN_MOUNTS,
  SPACE_ALERT_KINDS,
} from '../dashboard.constants';
import type { AppTile, BackupDay, DiskRow, Light, RackUnit, Text } from '../dashboard.model';

/** What the rack needs, from the global stores; null where it isn't known yet. */
export interface RackInput {
  alerts: Alert[];
  services: InstalledService[] | null;
  /** Null until the containers are known; `docker: false` when Docker can't be reached. */
  runtimes: Map<string, ServiceRuntime> | null;
  docker: boolean;
  backups: BackupsStatus | null;
  disks: DiskRow[] | null;
}

/** How the page's few changing words are made: alert titles, sizes, times (the store's helpers). */
export interface RackWords {
  alertTitle: (alert: Alert) => Wording;
  bytes: (bytes: number) => string;
  /** How long ago, as of the page's clock (it moves every minute). */
  ago: (at: string) => string;
  dateTime: (at: string) => string;
  percent: (percent: number) => string;
  /** A name that is machine text (a folder) kept left to right; a translated one as it is. */
  machine: (name: Text | string) => Text | string;
}

/** A unit that doesn't know yet says so. */
export const LOADING_KEY = 'dashboard.rack.loading';

const text = (key: string, params?: Record<string, unknown>, count?: number): Text => ({
  key,
  ...(params && { params }),
  ...(count !== undefined && { count }),
});
const fromWording = ([key, params]: Wording): Text => text(key, params);
const alertLight = (alerts: Alert[]): Light =>
  alerts.some((a) => a.severity === 'critical') ? 'fail' : 'warn';

export function rackUnits(input: RackInput, words: RackWords): RackUnit[] {
  return [appsUnit(input, words), backupsUnit(input, words), spaceUnit(input, words)];
}

/** The units that need the person: amber or red. */
export function needsAttention(units: RackUnit[]): number {
  return units.filter((unit) => unit.light === 'warn' || unit.light === 'fail').length;
}

function appsUnit({ alerts, services, runtimes, docker }: RackInput, words: RackWords): RackUnit {
  const unit = (light: Light, main: Text, sub: Text | null = null): RackUnit => ({
    id: 'apps',
    light,
    text: main,
    sub,
    link: '/services',
  });
  const open = alerts.filter((a) => APP_ALERT_KINDS.includes(a.kind));
  if (open.length > 0) {
    return unit(
      alertLight(open),
      fromWording(words.alertTitle(open[0])),
      open.length > 1 ? text('dashboard.rack.more', undefined, open.length - 1) : null,
    );
  }
  if (services === null) return unit('idle', text(LOADING_KEY));
  const installed = services.filter((s) => s.status !== 'removed');
  if (installed.length === 0) {
    return unit('idle', text('dashboard.rack.apps.none'), text('dashboard.rack.apps.noneSub'));
  }
  const failed = installed.find((s) => s.status === 'failed');
  if (failed) return unit('warn', text('dashboard.rack.apps.failed', { name: failed.name }));
  // Without the containers nothing is known about the apps: never green.
  if (!docker) return unit('warn', text('dashboard.rack.apps.dockerDown'));
  if (runtimes === null) return unit('idle', text(LOADING_KEY));
  const troubled = installed.find((s) =>
    ['partial', 'unhealthy'].includes(runtimes.get(s.catalogId) ?? ''),
  );
  if (troubled) {
    return unit(
      'warn',
      text(`dashboard.rack.apps.${runtimes.get(troubled.catalogId)}`, { name: troubled.name }),
    );
  }
  const running = installed.filter((s) => runtimes.get(s.catalogId) === 'running').length;
  const stopped = installed.filter((s) => runtimes.get(s.catalogId) === 'stopped').length;
  return unit(
    'ok',
    text('dashboard.rack.apps.running', undefined, running),
    stopped > 0
      ? text('dashboard.rack.apps.stopped', undefined, stopped)
      : text('dashboard.rack.apps.healthy'),
  );
}

function backupsUnit({ alerts, backups }: RackInput, words: RackWords): RackUnit {
  const unit = (light: Light, main: Text, sub: Text | null = null): RackUnit => ({
    id: 'backups',
    light,
    text: main,
    sub,
    link: '/backups',
  });
  if (backups === null) return unit('idle', text(LOADING_KEY));
  if (!backups.configured) {
    return unit(
      'warn',
      text('dashboard.rack.backups.notSetUp'),
      text('dashboard.rack.backups.notSetUpSub'),
    );
  }
  const next = backups.nextRunAt
    ? text('dashboard.rack.backups.next', { time: words.dateTime(backups.nextRunAt) })
    : null;
  if (backups.running) {
    const { items } = backups.running;
    return unit(
      'busy',
      text('dashboard.rack.backups.running'),
      text('dashboard.rack.backups.progress', {
        done: items.filter((i) => i.state === 'done').length,
        total: items.length,
      }),
    );
  }
  if (backups.warnings.length > 0) {
    const open = alerts.filter((a) => a.kind === 'backup');
    return unit(
      open.length > 0 ? alertLight(open) : 'warn',
      text(`backups.warning.${backups.warnings[0]}.title`),
      next,
    );
  }
  if (!backups.lastSuccessAt) return unit('ok', text('dashboard.rack.backups.never'), next);
  return unit(
    'ok',
    text('dashboard.rack.backups.last', { time: words.ago(backups.lastSuccessAt) }),
    next,
  );
}

function spaceUnit({ alerts, disks }: RackInput, words: RackWords): RackUnit {
  const unit = (light: Light, main: Text, sub: Text | null = null): RackUnit => ({
    id: 'space',
    light,
    text: main,
    sub,
    link: '/disks',
  });
  const open = alerts.filter((a) => SPACE_ALERT_KINDS.includes(a.kind));
  if (open.length > 0) {
    return unit(
      alertLight(open),
      fromWording(words.alertTitle(open[0])),
      open.length > 1 ? text('dashboard.rack.more', undefined, open.length - 1) : null,
    );
  }
  if (disks === null) return unit('idle', text(LOADING_KEY));
  if (disks.length === 0) return unit('idle', text('dashboard.storage.none'));
  const fullest = [...disks].sort((a, b) => b.percent - a.percent)[0];
  if (fullest.percent >= DISK_WARN_PERCENT) {
    return unit(
      'warn',
      text('dashboard.rack.space.filling', {
        name: words.machine(diskName(fullest)),
        percent: words.percent(fullest.percent),
      }),
    );
  }
  const system = disks.find((d) => d.kind === 'system') ?? fullest;
  const other = disks.filter((d) => d !== system).sort((a, b) => b.percent - a.percent)[0];
  return unit(
    'ok',
    text('dashboard.rack.space.free', {
      size: words.bytes(system.sizeBytes - system.usedBytes),
      name: words.machine(diskName(system)),
    }),
    other
      ? text('dashboard.rack.space.free', {
          name: words.machine(diskName(other)),
          size: words.bytes(other.sizeBytes - other.usedBytes),
        })
      : null,
  );
}

/** "System disk", "Backup disk", or the folder's own name ("photos" for /mnt/photos). */
export function diskName(disk: DiskRow): Text | string {
  if (disk.kind !== 'other') return text(`dashboard.disk.${disk.kind}`);
  return disk.mount.split('/').filter(Boolean).at(-1) ?? disk.mount;
}

/** The disks worth showing, the system disk first; the one holding the backups marked. */
export function shownDisks(disks: DiskUsage[], backupDestination: string | null): DiskRow[] {
  const shown = disks.filter((d) => !HIDDEN_MOUNTS.includes(d.mount));
  // The backup disk: the mount the destination folder is on (the longest that contains it).
  const backupMount = backupDestination
    ? shown
        .map((d) => d.mount)
        .filter(
          (m) => backupDestination === m || backupDestination.startsWith(m === '/' ? m : `${m}/`),
        )
        .sort((a, b) => b.length - a.length)[0]
    : undefined;
  return shown
    .map((d) => ({
      ...d,
      kind:
        d.mount === '/'
          ? ('system' as const)
          : d.mount === backupMount
            ? ('backup' as const)
            : ('other' as const),
      percent: percentOf(d.usedBytes, d.sizeBytes),
    }))
    .sort((a, b) =>
      a.kind === 'system' ? -1 : b.kind === 'system' ? 1 : a.mount.localeCompare(b.mount),
    );
}

/** One tile per installed service (not ones being removed), in the order of the list. */
export function appTiles(
  services: InstalledService[],
  containers: Container[] | null,
  runtimes: Map<string, ServiceRuntime>,
  pending: ReadonlyMap<string, unknown>,
): AppTile[] {
  return services
    .filter((s) => s.status !== 'removed')
    .map((service) => {
      const own = containers ? serviceContainers(service, containers) : [];
      return {
        service,
        runtime: runtimes.get(service.catalogId) ?? null,
        stopped: own.filter((c) => c.state !== 'running').map((c) => c.name),
        pending: own.some((c) => pending.has(c.name)),
        assistant: service.catalogId === ASSISTANT_CATALOG_ID,
      };
    });
}

/** Containers that belong to no service and aren't the platform's own. */
export function otherContainers(services: InstalledService[], containers: Container[]): number {
  const owned = new Set(services.flatMap((s) => serviceContainers(s, containers)).map((c) => c.id));
  return containers.filter((c) => !c.protected && !owned.has(c.id)).length;
}

/** The last `BACKUP_DAYS` days, oldest first, each with its worst finished run. */
export function backupDays(runs: BackupRun[], today: Date): BackupDay[] {
  const days: BackupDay[] = [];
  for (let i = BACKUP_DAYS - 1; i >= 0; i--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push({ date: localDate(day), outcome: null });
  }
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const run of runs) {
    if (!run.finishedAt || run.status === 'running') continue;
    const day = byDate.get(localDate(new Date(run.finishedAt)));
    if (
      day &&
      (day.outcome === null || BACKUP_OUTCOME_RANK[run.status] > BACKUP_OUTCOME_RANK[day.outcome])
    ) {
      day.outcome = run.status;
    }
  }
  return days;
}

/** A date in the browser's time zone, as YYYY-MM-DD. */
function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
