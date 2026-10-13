import { readFile, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { DiskUsage, HostInfo } from '@homelab/shared';
import {
  diskMounts,
  isShownInterface,
  parseCpuTimes,
  parseListeningTcpPorts,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseOsRelease,
} from './proc-parsers.js';
import type { CpuTimes, FolderState, MemoryInfo, NetCounters } from './host.model.js';

/**
 * The only place the host's state is read: plain files under `/proc` and `/etc`, folders,
 * `statfs()` and Node's `os` — no child processes, no privileges. Everything else works on what
 * this returns, so tests use a fake.
 */
export class SystemReader {
  /** `root` is `/` on the host; container mode (later) points it at the host's mounted root. */
  constructor(private readonly root = '/') {}

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

  private read(path: string): Promise<string> {
    return readFile(join(this.root, path), 'utf8');
  }
}
