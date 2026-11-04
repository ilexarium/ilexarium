/** Never mounted into a service or backed up, whatever is configured (the wrappers keep their own list). */
export const SYSTEM_FOLDERS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/lib/laris',
  '/var/run',
  '/opt/laris',
];

/**
 * hwmon chips that measure the processor, best first, each with its labels to prefer. Only these
 * are read: some others are slow to read or wake sleeping disks (`drivetemp`).
 */
export const CPU_HWMON_CHIPS: [chip: string, labels: string[]][] = [
  ['coretemp', ['Package id 0']],
  ['k10temp', ['Tdie', 'Tctl']],
  ['zenpower', ['Tdie', 'Tctl']],
  ['cpu_thermal', []],
  ['cpu-thermal', []],
  ['soc_thermal', []],
];

/** Thermal zone types that measure the processor, best first (when no hwmon chip does). */
export const CPU_THERMAL_ZONES = [/^x86_pkg_temp$/, /^cpu[-_]?thermal/, /^cpu/, /^soc/, /^acpitz$/];

/** Readings outside this range are a broken or unwired sensor. */
export const TEMPERATURE_RANGE_C = { min: -40, max: 150 };

/** systemd's marker files: one per account with lingering on, named after it. */
export const LINGER_DIR = 'var/lib/systemd/linger';
