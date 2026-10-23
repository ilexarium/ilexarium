import {
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
import { SYSTEM_FOLDERS } from '../../apps/server/src/host/host.constants.ts';
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
});
