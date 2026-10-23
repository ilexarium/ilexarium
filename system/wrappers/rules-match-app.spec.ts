import {
  BACKUP_DESTINATION_ROOTS,
  BACKUP_FILESYSTEMS,
  BACKUP_FREQUENCIES,
  BACKUP_LIMITS,
  BACKUP_REPOSITORY_FOLDER,
  BACKUP_TIME_PATTERN,
  CATALOG_ID_PATTERN,
  CATALOG_LIMITS,
  ENUM_OPTION_PATTERN,
  FIELD_KEY_PATTERN,
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
import { SYSTEM_FOLDERS } from '../../apps/server/src/host/host.constants.ts';
import * as wrapperConfigure from './backup/configure.mts';
import * as wrapperBackupConfig from './backup/config.mts';
import * as wrapperDestination from './backup/destination.mts';
import * as wrapperPlan from './backup/plan.mts';
import * as wrapperCatalog from './compose/catalog.mts';
import * as wrapperPolicy from './compose/policy.mts';
import * as wrapperValues from './compose/values.mts';
import * as wrapperPaths from './lib/paths.mts';

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
});
