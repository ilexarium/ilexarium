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
  '/var/run',
  // The backup wrapper's restore area: a restored platform backup holds the master key and the
  // database dump — never mounted into a container, never backed up (the wrappers deny it too).
  '/srv/laris/restores',
];
