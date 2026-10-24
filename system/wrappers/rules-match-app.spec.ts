import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_DESTINATION_ROOTS,
  BACKUP_FILESYSTEMS,
  BACKUP_FREQUENCIES,
  BACKUP_LIMITS,
  BACKUP_REPOSITORY_FOLDER,
  BACKUP_TIME_PATTERN,
  CATALOG_ID_PATTERN,
  CATALOG_LIMITS,
  DISK_FILESYSTEMS,
  DISK_MOUNT_ROOT,
  DISK_NAME_PATTERN,
  DISK_UUID_PATTERN,
  ENUM_OPTION_PATTERN,
  FIELD_KEY_PATTERN,
  PROCESS_LIMITS,
  PATH_FORBIDDEN,
  TEXT_PATTERNS,
} from '@laris/shared';
import {
  LOG_DRIVERS,
  PINNED_IMAGE,
  PORT_HOST_ADDRESSES,
  RESERVED_LABEL,
  SERVICE_KEYS,
  VOLUME_KEYS,
} from '../../apps/server/src/catalog/compose-policy.constants.ts';
import { scheduleHours } from '../../apps/server/src/backups/backup-status.ts';
import { ROOT_PLACES, SYSTEM_MOUNTS } from '../../apps/server/src/disks/disks.constants.ts';
import { SYSTEM_FOLDERS } from '../../apps/server/src/host/host.constants.ts';
import {
  CONTAINER_CGROUP,
  isKernelThread,
  parseContainerId,
} from '../../apps/server/src/host/process-parsers.ts';
import * as wrapperConfigure from './backup/configure.mts';
import * as wrapperBackupConfig from './backup/config.mts';
import * as wrapperDestination from './backup/destination.mts';
import * as wrapperPlan from './backup/plan.mts';
import * as wrapperCatalog from './compose/catalog.mts';
import * as wrapperPolicy from './compose/policy.mts';
import * as wrapperValues from './compose/values.mts';
import * as wrapperDiskConfig from './disk/config.mts';
import * as wrapperDiskDevices from './disk/devices.mts';
import * as wrapperDiskMount from './disk/mount.mts';
import * as wrapperDiskUnits from './disk/units.mts';
import * as wrapperPaths from './lib/paths.mts';
import * as wrapperProcessConfig from './process/config.mts';
import * as wrapperProc from './process/proc.mts';

// The app's rules and the root wrappers' are written twice on purpose (the wrappers share no code
// with the app). This keeps the two copies the same; that they are right is the wrappers' own
// tests and the review of system/. Compared as whole regular expressions (flags included).
describe('the app and the root wrappers check the same rules', () => {
  it('service keys: the same, the wrapper also allowing `networks` (docker compose config writes it)', () => {
    expect([...wrapperPolicy.SERVICE_KEYS].sort()).toEqual([...SERVICE_KEYS, 'networks'].sort());
  });

  it('log drivers, volume entry keys, and where a port may be published (every address or loopback only)', () => {
    expect(new Set(wrapperPolicy.LOG_DRIVERS)).toEqual(LOG_DRIVERS);
    expect(new Set(wrapperPolicy.VOLUME_KEYS)).toEqual(VOLUME_KEYS);
    expect(wrapperPolicy.PORT_HOST_ADDRESSES).toEqual(PORT_HOST_ADDRESSES);
  });

  it('images pinned by digest, and the reserved labels', () => {
    expect(String(wrapperPolicy.PINNED_IMAGE)).toBe(String(PINNED_IMAGE));
    expect(String(wrapperPolicy.RESERVED_LABEL)).toBe(String(RESERVED_LABEL));
  });

  it('the folders never allowed, and the characters a folder may not hold', () => {
    expect(new Set(wrapperPaths.DENIED_PATHS)).toEqual(new Set(SYSTEM_FOLDERS));
    expect(String(wrapperPaths.PATH_FORBIDDEN)).toBe(String(PATH_FORBIDDEN));
    expect(wrapperPaths.PATH_MAX).toBe(CATALOG_LIMITS.pathMax);
  });

  it('ports, secrets, text patterns, ids, field keys and enum options', () => {
    expect(wrapperValues.TEXT_MAX).toBe(CATALOG_LIMITS.textMax);
    expect([wrapperValues.PORT_MIN, wrapperValues.PORT_MAX]).toEqual([
      CATALOG_LIMITS.portMin,
      CATALOG_LIMITS.portMax,
    ]);
    expect(String(wrapperValues.SECRET_PATTERN)).toBe(
      `/^[^\\x00-\\x1f\\x7f]{${CATALOG_LIMITS.secretMin},${CATALOG_LIMITS.secretMax}}$/`,
    );
    expect(
      Object.fromEntries(
        Object.entries(wrapperCatalog.TEXT_PATTERNS).map(([k, v]) => [k, String(v)]),
      ),
    ).toEqual(Object.fromEntries(Object.entries(TEXT_PATTERNS).map(([k, v]) => [k, String(v)])));
    expect(String(wrapperCatalog.ID_PATTERN)).toBe(String(CATALOG_ID_PATTERN));
    expect(String(wrapperCatalog.KEY_PATTERN)).toBe(String(FIELD_KEY_PATTERN));
    expect(String(wrapperCatalog.ENUM_OPTION_PATTERN)).toBe(String(ENUM_OPTION_PATTERN));
  });

  it('backups: where disks may be, their formats, the repository folder, the item limit, the time', () => {
    expect(wrapperBackupConfig.DESTINATION_ROOTS).toEqual([...BACKUP_DESTINATION_ROOTS]);
    expect(wrapperDestination.FILESYSTEMS).toEqual(new Set(BACKUP_FILESYSTEMS));
    expect(wrapperDestination.REPOSITORY_FOLDER).toBe(BACKUP_REPOSITORY_FOLDER);
    expect(wrapperPlan.MAX_ITEMS).toBe(BACKUP_LIMITS.maxItems);
    expect(String(wrapperPlan.TIME_PATTERN)).toBe(String(BACKUP_TIME_PATTERN));
  });

  it('backups: the timer runs at the hours the app shows as the next run', () => {
    for (const frequency of BACKUP_FREQUENCIES) {
      for (const time of ['00:00', '03:15', '13:45', '23:59']) {
        const hours = scheduleHours({ frequency, time })
          .map((h) => String(h).padStart(2, '0'))
          .join(',');
        expect(wrapperConfigure.onCalendar({ frequency, time })).toBe(
          `*-*-* ${hours}:${time.slice(3)}:00`,
        );
      }
    }
  });

  it('disks: the system disk, the file systems, the mount folder, names and UUIDs', () => {
    expect(new Set(wrapperDiskDevices.SYSTEM_MOUNTS)).toEqual(new Set(SYSTEM_MOUNTS));
    expect(new Set(wrapperDiskUnits.FILESYSTEMS)).toEqual(new Set(DISK_FILESYSTEMS));
    expect(wrapperDiskConfig.ROOT_PATHS.mountRoot).toBe(DISK_MOUNT_ROOT);
    expect(ROOT_PLACES.mountRoot).toBe(DISK_MOUNT_ROOT);
    expect(ROOT_PLACES.unitDir).toBe(wrapperDiskConfig.ROOT_PATHS.unitDir);
    expect(String(wrapperDiskUnits.NAME)).toBe(String(DISK_NAME_PATTERN));
    expect(String(wrapperDiskMount.UUID)).toBe(String(DISK_UUID_PATTERN));
  });

  it('processes: whose processes are people’s, and what a kernel thread is', () => {
    expect(wrapperProcessConfig.DEFAULT_MIN_UID).toBe(PROCESS_LIMITS.minUid);
    expect(wrapperProcessConfig.MAX_UID).toBe(PROCESS_LIMITS.maxUid);
    expect(isKernelThread({ flags: wrapperProc.PF_KTHREAD })).toBe(true);
    expect(isKernelThread({ flags: 0 })).toBe(false);
  });

  it('processes: the same rule for "in a container", and the same answers on real cgroups', () => {
    expect(String(wrapperProc.CONTAINER_CGROUP)).toBe(String(CONTAINER_CGROUP));
    const id = 'a'.repeat(64);
    const cgroups = [
      // Where the two sides once disagreed: Podman without systemd, containerd, Docker without
      // `.scope`, Docker's own subtrees, a containerd scope without a full ID.
      `0::/libpod_parent/libpod-${id}`,
      `0::/containerd/${id}`,
      `0::/x/docker-${id}`,
      '0::/docker/buildkit/xyz',
      '0::/system.slice/cri-containerd-abc.scope',
      `0::/system.slice/docker-${id}.scope`,
      `12:pids:/docker/${id}\n11:memory:/docker/${id}`,
      `0::/machine.slice/libpod-${id}.scope/container`,
      `0::/kubepods/besteffort/pod1/cri-containerd-${id}.scope`,
      '0::/kubepods/burstable/pod1/abc',
      '0::/machine.slice/machine-web.scope/payload',
      '0::/lxc/web/init.scope',
      `0::/user.slice/user-1000.slice/user@1000.service/app.slice/docker-${id}.scope`,
      '0::/system.slice/docker.service',
      '0::/system.slice/containerd.service',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/docker.service',
      '0::/user.slice/user-1000.slice/session-2.scope',
      '0::/system.slice/sshd.service',
    ];
    const proc = mkdtempSync(join(tmpdir(), 'rules-proc-'));
    try {
      for (const [i, cgroup] of cgroups.entries()) {
        const pid = 100 + i;
        const dir = join(proc, String(pid));
        mkdirSync(dir);
        // Enough of /proc/<pid> for the wrapper's reader: stat (start time, flags), uids, cgroup.
        const fields = Array.from({ length: 50 }, () => '0');
        writeFileSync(join(dir, 'stat'), `${pid} (sh) S ${fields.join(' ')}\n`);
        writeFileSync(join(dir, 'status'), 'Uid:\t1000\t1000\t1000\t1000\n');
        writeFileSync(join(dir, 'cgroup'), `${cgroup}\n`);
        const app = parseContainerId(cgroup) !== null;
        expect(wrapperProc.readProcess(proc, pid)?.inContainer, cgroup).toBe(app);
      }
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });
});
