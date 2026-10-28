// disk/mount.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// `mount` and `unmount`. Everything is checked here again, from the kernel's and udev's own
// records — nothing the app says about a disk is trusted.

import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  deviceByUuid,
  mountsOf,
  readDevices,
  readMounts,
  readSwaps,
  systemDisks,
  udevProperties,
} from './devices.mts';
import { pretendMount, pretendUnmount } from './development.mts';
import type { Config, Paths } from './model.mts';
import { systemctl } from './programs.mts';
import { FILESYSTEMS, SYSTEM_FOLDERS, isOurs, unitContent, unitName, unitPath } from './units.mts';
import { parseInput } from '../lib/input.mts';
import { tryLock } from '../lib/lock.mts';
import { Refusal, emit, oneLine } from '../lib/output.mts';
import { inside, isPlainAbsolutePath } from '../lib/paths.mts';
import { isRoot } from '../lib/startup.mts';

/** A filesystem UUID as udev names it (ext4/xfs/btrfs: 36 characters; exFAT: XXXX-XXXX). */
export const UUID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** The highest uid or gid a top folder may be given. */
export const ID_MAX = 4_294_967_294;

/** A mount point: a plain absolute path, never `/`, a system folder or inside one. */
export function parseMountPoint(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isPlainAbsolutePath(value) ||
    value === '/' ||
    value.length > 512 ||
    SYSTEM_FOLDERS.some((folder) => inside(value, folder))
  ) {
    throw new Refusal('invalid_request', 'mount point', 2, 'mountPoint');
  }
  return value;
}

function parseOwner(value: unknown): { uid: number; gid: number } | null {
  if (value === null) return null;
  const owner = value as { uid?: unknown; gid?: unknown } | undefined;
  const id = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= ID_MAX;
  if (typeof value !== 'object' || !id(owner?.uid) || !id(owner?.gid) || Object.keys(value).length !== 2) {
    throw new Refusal('invalid_request', 'owner', 2, 'owner');
  }
  return { uid: owner!.uid as number, gid: owner!.gid as number };
}

/** Where the folder really is: the mount point itself, or in development inside the pretend root. */
const folderOf = (paths: Paths, where: string) => (isRoot ? where : join(paths.mountRoot, where));

function lock(paths: Paths): () => void {
  const release = tryLock(paths.lock);
  if (!release) throw new Refusal('busy', 'another operation is running', 3);
  return release;
}

/** The backup wrapper's plan names this folder (or one inside it) as its disk. */
function usedForBackups(paths: Paths, where: string): boolean {
  try {
    const plan = JSON.parse(readFileSync(paths.backupPlan, 'utf8')) as { destination?: unknown };
    return typeof plan.destination === 'string' && inside(plan.destination, where);
  } catch {
    return false;
  }
}

export async function mount(config: Config, paths: Paths, input: string): Promise<string> {
  const request = parseInput(input, ['uuid', 'mountPoint', 'owner']);
  const where = parseMountPoint(request['mountPoint']);
  const owner = parseOwner(request['owner']);
  const uuid = request['uuid'];
  if (typeof uuid !== 'string' || !UUID.test(uuid)) {
    throw new Refusal('invalid_request', 'uuid', 2, 'uuid');
  }
  const release = lock(paths);
  try {
    const { device, number, fsType } = checkDevice(paths, uuid);
    const folder = folderOf(paths, where);
    // Development: the pretend root has no folders of its own yet.
    if (!isRoot) mkdirSync(dirname(folder), { recursive: true });
    checkMountPoint(paths, where, folder);
    const unit = unitPath(paths, where);
    if (existsSync(unit)) {
      throw new Refusal('mount_point_in_use', `${unitName(where)} exists`, 2, 'mountPoint');
    }

    emit('@@phase mounting');
    const created = !existsSync(folder);
    if (created) mkdirSync(folder, { mode: 0o755 });
    // Explicit modes (the umask is 077): the folder is everyone's to enter, and the app reads
    // the unit to list the disks it manages.
    chmodSync(folder, 0o755);
    mkdirSync(paths.unitDir, { recursive: true });
    const temporary = `${unit}.${process.pid}.tmp`;
    writeFileSync(temporary, unitContent(uuid, fsType, where));
    chmodSync(temporary, 0o644);
    renameSync(temporary, unit);
    try {
      await start(config, paths, where, { device, number, fsType });
      // "Make the top folder mine": the disk's own top folder, nothing inside it.
      if (owner && isRoot) chownSync(folder, owner.uid, owner.gid);
    } catch (error) {
      // Undone: nothing of the attempt stays (the next try starts clean).
      await stop(config, paths, where).catch(() => undefined);
      rmSync(unit, { force: true });
      if (config.disk.systemctlBin) {
        await systemctl(config.disk.systemctlBin, ['daemon-reload']).catch(() => undefined);
      }
      if (created) removeEmptyFolder(folder);
      throw error;
    }
    return where;
  } finally {
    release();
  }
}

export async function unmount(config: Config, paths: Paths, input: string): Promise<void> {
  const request = parseInput(input, ['mountPoint']);
  const where = parseMountPoint(request['mountPoint']);
  const unit = unitPath(paths, where);
  const release = lock(paths);
  try {
    // Checked under the lock: the backup program's `configure` can't move the backups onto it
    // in between.
    if (!isOurs(unit)) throw new Refusal('not_managed', 'not a disk mounted here', 2, 'mountPoint');
    if (usedForBackups(paths, where)) {
      throw new Refusal('used_for_backups', 'the backups are kept on this disk', 2, 'mountPoint');
    }
    emit('@@phase unmounting');
    await stop(config, paths, where);
    rmSync(unit, { force: true });
    if (config.disk.systemctlBin) await systemctl(config.disk.systemctlBin, ['daemon-reload']);
    removeEmptyFolder(folderOf(paths, where));
  } finally {
    release();
  }
}

/**
 * The device udev knows by this UUID: the only one with it (a copied disk shares its UUID, and
 * /dev/disk/by-uuid would point the unit at either after a restart), a supported filesystem,
 * free to mount, not the system's.
 */
function checkDevice(
  paths: Paths,
  uuid: string,
): { device: string; number: string; fsType: string } {
  const name = deviceByUuid(paths, uuid);
  const devices = readDevices(paths);
  const device = name ? devices.get(name) : undefined;
  if (!device) throw new Refusal('disk_not_found', 'no disk with this UUID', 2, 'uuid');
  if (isRoot && !lstatSync(`/dev/${device.name}`).isBlockDevice()) {
    throw new Refusal('disk_not_found', 'not a block device', 2, 'uuid');
  }
  if ([...devices.values()].filter((d) => d.uuid === uuid).length > 1) {
    throw new Refusal('duplicate_uuid', 'another device has the same UUID', 2, 'uuid');
  }
  const udev = udevProperties(paths, device.number);
  const fsType = udev.get('ID_FS_TYPE') ?? '';
  if (udev.get('ID_FS_UUID') !== uuid)
    throw new Refusal('disk_not_found', 'UUID changed', 2, 'uuid');
  if (!FILESYSTEMS.includes(fsType)) {
    throw new Refusal('unsupported_filesystem', `${fsType || 'no filesystem'}`, 2, 'uuid');
  }
  const mounts = readMounts(paths);
  if (!device.partition && device.partitions.length > 0) {
    throw new Refusal('disk_in_use', 'a disk with partitions', 2, 'uuid');
  }
  if (device.holders.length > 0 || readSwaps(paths).has(device.name)) {
    throw new Refusal('disk_in_use', 'used by another device or as swap', 2, 'uuid');
  }
  if (mountsOf(device, mounts).length > 0) {
    throw new Refusal('disk_in_use', 'already mounted', 2, 'uuid');
  }
  if (systemDisks(devices, mounts).has(device.disk)) {
    throw new Refusal('system_disk', 'the system runs from this disk', 2, 'uuid');
  }
  return { device: device.name, number: device.number, fsType };
}

/**
 * The mount point: its parent an existing folder (not a link: the unit would follow it), itself
 * missing or an empty folder (not a link) that nothing is mounted on.
 */
function checkMountPoint(paths: Paths, where: string, folder: string): void {
  const taken = (why: string) => new Refusal('mount_point_in_use', `${where}: ${why}`, 2, 'mountPoint');
  let parent;
  try {
    parent = lstatSync(dirname(folder));
  } catch {
    throw taken('its parent folder is missing');
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw taken('its parent is not a folder');
  let stat;
  try {
    stat = lstatSync(folder);
  } catch {
    return;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    readdirSync(folder).length > 0 ||
    readMounts(paths).some((m) => m.point === where)
  ) {
    throw taken('not an empty folder, or something is mounted there');
  }
}

async function start(
  config: Config,
  paths: Paths,
  where: string,
  { device, number, fsType }: { device: string; number: string; fsType: string },
): Promise<void> {
  const bin = config.disk.systemctlBin;
  if (!bin) return pretendMount(paths, where, { device, number, fsType });
  const unit = unitName(where);
  for (const args of [['daemon-reload'], ['enable', '--now', unit]]) {
    const ran = await systemctl(bin, args);
    if (ran.code !== 0) {
      emit(`@@info ${oneLine(ran.text).slice(0, 500)}`);
      throw new Refusal('mount_failed', `systemctl ${args[0]} failed`, 5);
    }
  }
  if (!readMounts(paths).some((m) => m.point === where)) {
    throw new Refusal('mount_failed', 'the disk is not mounted after starting its unit', 5);
  }
}

async function stop(config: Config, paths: Paths, where: string): Promise<void> {
  const bin = config.disk.systemctlBin;
  if (!bin) return pretendUnmount(paths, where);
  const unit = unitName(where);
  const ran = await systemctl(bin, ['disable', '--now', unit]);
  if (ran.code !== 0 || readMounts(paths).some((m) => m.point === where)) {
    if (/busy/i.test(ran.text) || readMounts(paths).some((m) => m.point === where)) {
      // `disable --now` disables before it stops: still mounted, it must stay enabled too, or it
      // wouldn't come back after a restart.
      await systemctl(bin, ['enable', unit]);
      throw new Refusal('disk_busy', 'files on the disk are open', 3);
    }
    emit(`@@info ${oneLine(ran.text).slice(0, 500)}`);
    throw new Refusal('unmount_failed', 'systemctl disable failed', 5);
  }
}

function removeEmptyFolder(where: string): void {
  try {
    rmdirSync(where);
  } catch {
    // not empty, or already gone: left as it is
  }
}
