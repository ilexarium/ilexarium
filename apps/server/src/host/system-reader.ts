import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { DiskUsage, HostInfo } from '@laris/shared';
import {
  isShownInterface,
  parseCpuTimes,
  parseListeningTcpPorts,
  parseMeminfo,
  parseNetDev,
  parseOsRelease,
} from './proc-parsers.js';
import {
  diskMounts,
  parseDiskUnit,
  parseMountInfo,
  parseMounts,
  parseSwaps,
  parseUdevData,
} from './disk-parsers.js';
import {
  parseBootTime,
  parseCmdline,
  parseContainerId,
  parsePasswd,
  parseProcStat,
  parseProcStatus,
  procHidesProcesses,
} from './process-parsers.js';
import type {
  BlockDevice,
  CpuTimes,
  FolderState,
  MemoryInfo,
  MountPoint,
  NetCounters,
  RawProcess,
  Space,
  Subfolder,
} from './host.model.js';

/** /proc/<pid>/ folders read at once (four files each). */
const PROCESS_BATCH = 64;

/** The only place the host's state is read: files, `statfs()` and Node's `os` — no commands. */
export class SystemReader {
  /** `root` is `/` on the host; container mode (later) points it at the host's mounted root. */
  constructor(private readonly root = '/') {}

  /** A reader of another root below this one (development: the disk wrapper's pretend host). */
  within(root: string): SystemReader {
    return root === '/' ? this : new SystemReader(join(this.root, root));
  }

  async cpuTimes(): Promise<CpuTimes> {
    return parseCpuTimes(await this.read('proc/stat'));
  }

  async memory(): Promise<MemoryInfo> {
    return parseMeminfo(await this.read('proc/meminfo'));
  }

  /** Shown interfaces only (see `isShownInterface`). */
  async netCounters(): Promise<Map<string, NetCounters>> {
    const all = parseNetDev(await this.read('proc/net/dev'));
    return new Map([...all].filter(([name]) => isShownInterface(name)));
  }

  /** Real local filesystems; ones that can't be measured (no permission, size 0) are left out. */
  async disks(): Promise<DiskUsage[]> {
    const mounts = diskMounts(parseMounts(await this.read('proc/self/mounts')));
    const disks = await Promise.all(
      mounts.map(async ({ device, mount, fsType }): Promise<DiskUsage | null> => {
        try {
          const { blocks, bfree, bsize } = await statfs(join(this.root, mount));
          if (blocks === 0) return null;
          return {
            device,
            mount,
            fsType,
            sizeBytes: blocks * bsize,
            usedBytes: (blocks - bfree) * bsize,
          };
        } catch {
          return null;
        }
      }),
    );
    return disks.filter((disk) => disk !== null);
  }

  loadAverage(): [number, number, number] {
    const [one, five, fifteen] = os.loadavg();
    return [one, five, fifteen];
  }

  uptimeSeconds(): number {
    return os.uptime();
  }

  async hostInfo(): Promise<HostInfo> {
    const osName = await this.read('etc/os-release')
      .then(parseOsRelease)
      .catch(() => null);
    const model = os.cpus()[0]?.model.trim();
    return {
      hostname: os.hostname(),
      os: osName ?? `${os.type()} ${os.release()}`,
      kernel: os.release(),
      arch: os.arch(),
      cpuModel: model && model.toLowerCase() !== 'unknown' ? model : null,
      cpuCores: os.availableParallelism(),
    };
  }

  /** TCP ports something listens on, IPv4 and IPv6 (`tcp6` is missing when IPv6 is off). */
  async listeningTcpPorts(): Promise<Set<number>> {
    const ports = new Set<number>();
    for (const file of ['proc/net/tcp', 'proc/net/tcp6']) {
      const text = await this.read(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      for (const port of parseListeningTcpPorts(text)) ports.add(port);
    }
    return ports;
  }

  /** What is at an absolute path, as far as the app's user may see. */
  async folder(path: string): Promise<FolderState> {
    try {
      return (await stat(join(this.root, path))).isDirectory() ? 'folder' : 'other';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
  }

  /**
   * Every mount point, from /proc/self/mountinfo — or, in development, the pretend mount table
   * the backup wrapper is configured with (an absolute path).
   */
  async mountPoints(file = 'proc/self/mountinfo'): Promise<MountPoint[]> {
    return parseMountInfo(await this.read(file));
  }

  /** Size and free space of the file system holding `path`; null if it can't be measured. */
  async space(path: string): Promise<Space | null> {
    try {
      const { blocks, bavail, bsize } = await statfs(join(this.root, path));
      return { totalBytes: blocks * bsize, freeBytes: bavail * bsize };
    } catch {
      return null;
    }
  }

  /** The device a path is on (to tell whether two folders share a disk); null if unreadable. */
  async device(path: string): Promise<number | null> {
    try {
      return (await stat(join(this.root, path))).dev;
    } catch {
      return null;
    }
  }

  /**
   * The folders directly inside `path` (not symlinks), by name, at most `limit`; null when the
   * app's user may not look (another user's home) or it isn't a folder.
   */
  async subfolders(path: string, limit = 500): Promise<Subfolder[] | null> {
    try {
      const entries = await readdir(join(this.root, path), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, limit)
        .map((name) => ({ name, path: path === '/' ? `/${name}` : `${path}/${name}` }));
    } catch {
      return null;
    }
  }

  /**
   * Block devices (disks and partitions) from /sys/class/block, with their filesystem, UUID and
   * label from udev's database — memory, loop and optical devices left out.
   */
  async blockDevices(): Promise<BlockDevice[]> {
    const root = 'sys/class/block';
    const names = ((await this.list(root)) ?? []).filter(
      (name) => /^[a-z][a-z0-9-]{1,31}$/.test(name) && !/^(loop|ram|zram|sr|fd)\d/.test(name),
    );
    const devices = new Map<string, BlockDevice>();
    for (const name of names) {
      const dir = `${root}/${name}`;
      const number = (await this.readOptional(`${dir}/dev`))?.trim();
      if (!number || !/^\d+:\d+$/.test(number)) continue;
      const udev = parseUdevData((await this.readOptional(`run/udev/data/b${number}`)) ?? '');
      const sectors = Number((await this.readOptional(`${dir}/size`))?.trim() ?? 0);
      devices.set(name, {
        name,
        number,
        partition: (await this.readOptional(`${dir}/partition`)) !== null,
        disk: name,
        partitions: [],
        holders: (await this.list(`${dir}/holders`)) ?? [],
        slaves: (await this.list(`${dir}/slaves`)) ?? [],
        sizeBytes: Number.isFinite(sectors) ? sectors * 512 : 0,
        removable: (await this.readOptional(`${dir}/removable`))?.trim() === '1',
        model: (await this.readOptional(`${dir}/device/model`))?.trim() || null,
        fsType: udev.get('ID_FS_TYPE') || null,
        uuid: udev.get('ID_FS_UUID') || null,
        label: udev.get('ID_FS_LABEL') || null,
      });
    }
    // A partition's disk: the disk whose folder holds a folder of the partition's name.
    for (const disk of devices.values()) {
      if (disk.partition) continue;
      for (const entry of (await this.list(`${root}/${disk.name}`)) ?? []) {
        const part = devices.get(entry);
        if (!part?.partition) continue;
        part.disk = disk.name;
        disk.partitions.push(part.name);
      }
      disk.partitions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    }
    return [...devices.values()];
  }

  /** The devices used as swap, by kernel name. */
  async swaps(): Promise<string[]> {
    return parseSwaps((await this.readOptional('proc/swaps')) ?? '');
  }

  /** The mount units the disk wrapper wrote in `unitDir` (an absolute path). */
  async diskUnits(
    unitDir: string,
  ): Promise<{ name: string; uuid: string | null; where: string }[]> {
    const units = [];
    for (const file of (await this.list(unitDir)) ?? []) {
      if (!file.startsWith('mnt-') || !file.endsWith('.mount')) continue;
      const unit = parseDiskUnit((await this.readOptional(`${unitDir}/${file}`)) ?? '');
      if (unit) units.push({ name: unit.where.slice(unit.where.lastIndexOf('/') + 1), ...unit });
    }
    return units;
  }

  /**
   * Every process; one that ends while being read is left out. Read 64 at a time (4 files each):
   * all at once would run out of file descriptors on a busy machine and crowd out other work.
   */
  async processes(): Promise<RawProcess[]> {
    const pids = ((await this.list('proc')) ?? []).filter((name) => /^\d+$/.test(name));
    const processes: RawProcess[] = [];
    for (let i = 0; i < pids.length; i += PROCESS_BATCH) {
      const batch = await Promise.all(
        pids.slice(i, i + PROCESS_BATCH).map((pid) => this.process(Number(pid))),
      );
      for (const process of batch) if (process) processes.push(process);
    }
    return processes;
  }

  /** One process, or null if there is none with this PID (or it ended while being read). */
  async process(pid: number): Promise<RawProcess | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const [stat, status, cmdline, cgroup] = await Promise.all([
      this.readProc(`proc/${pid}/stat`),
      this.readProc(`proc/${pid}/status`),
      this.readProc(`proc/${pid}/cmdline`),
      this.readProc(`proc/${pid}/cgroup`),
    ]);
    const parsed = stat ? parseProcStat(stat) : null;
    const owner = status ? parseProcStatus(status) : null;
    if (!parsed || !owner || parsed.pid !== pid) return null;
    return {
      ...parsed,
      ...owner,
      command: parseCmdline(cmdline ?? ''),
      containerId: parseContainerId(cgroup ?? ''),
    };
  }

  /** Account names by uid, from /etc/passwd (empty if it can't be read). */
  async users(): Promise<Map<number, string>> {
    return parsePasswd((await this.readOptional('etc/passwd')) ?? '');
  }

  /** When the machine booted, in seconds since 1970. */
  async bootTime(): Promise<number | null> {
    return parseBootTime(await this.read('proc/stat'));
  }

  /** Whether /proc hides other users' processes (`hidepid`). */
  async procHidden(): Promise<boolean> {
    return procHidesProcesses((await this.readOptional('proc/self/mounts')) ?? '');
  }

  /**
   * A file of /proc/<pid>/: null once the process has ended (ENOENT, ESRCH); any other error
   * (out of file descriptors, …) is thrown — a process must never silently drop off the list.
   */
  private async readProc(path: string): Promise<string | null> {
    try {
      return await this.read(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return null;
      throw error;
    }
  }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.read(path);
    } catch {
      return null;
    }
  }

  private async list(path: string): Promise<string[] | null> {
    try {
      return await readdir(join(this.root, path));
    } catch {
      return null;
    }
  }

  private read(path: string): Promise<string> {
    return readFile(join(this.root, path), 'utf8');
  }
}
