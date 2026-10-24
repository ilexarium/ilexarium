import type { ProcStat } from './host.model.js';

/** PF_KTHREAD in a process's flags: a kernel thread. */
const PF_KTHREAD = 0x0020_0000;

/** A kernel thread, by its flags (`/proc/<pid>/stat` field 9). */
export function isKernelThread(stat: Pick<ProcStat, 'flags'>): boolean {
  return (stat.flags & PF_KTHREAD) !== 0;
}

/**
 * `/proc/<pid>/stat`. The name sits in parentheses and may itself hold spaces and `)`, so the
 * fields are counted from the **last** `)`: state is field 3, flags 9, utime 14, stime 15,
 * starttime 22. Null for anything else (the process ended while being read).
 */
export function parseProcStat(stat: string): ProcStat | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const pid = Number(stat.slice(0, open).trim());
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields[0] is field 3 (state).
  const field = (n: number) => fields[n - 3];
  const startTicks = field(22);
  if (!Number.isInteger(pid) || pid <= 0 || !startTicks || !/^\d+$/.test(startTicks)) return null;
  return {
    pid,
    name: stat.slice(open + 1, close),
    state: field(3),
    flags: Number(field(9)),
    cpuTicks: Number(field(14)) + Number(field(15)),
    startTicks,
  };
}

/** `/proc/<pid>/status`: its four uids and its resident memory (VmRSS, absent for kernel threads). */
export function parseProcStatus(
  status: string,
): { uids: [number, number, number, number]; rssBytes: number } | null {
  const uidLine = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
  if (!uidLine) return null;
  const rss = /^VmRSS:\s+(\d+)\s*kB/m.exec(status);
  const uids = uidLine.slice(1, 5).map(Number) as [number, number, number, number];
  return { uids, rssBytes: rss ? Number(rss[1]) * 1024 : 0 };
}

/** `/proc/<pid>/cmdline`: arguments separated (and ended) by NUL bytes. */
export function parseCmdline(cmdline: string): string {
  return cmdline.replace(/\0+$/, '').replace(/\0/g, ' ');
}

/**
 * A container's cgroup, its ID known or not: Docker's, Podman's, containerd's, Kubernetes pods,
 * LXC, systemd-nspawn machines — but not the daemons' own services (`docker.service`,
 * `containerd.service`). The process wrapper writes the same rule (a test compares them).
 */
export const CONTAINER_CGROUP =
  /\/docker\/|(?:docker|libpod|containerd)[-/][0-9a-f]{64}|(?:docker|libpod|cri-containerd)-[^/\s]*\.scope|\/kubepods\b|\/lxc[./]|\/machine\.slice\//m;

/**
 * The container a process runs in, from `/proc/<pid>/cgroup`: Docker's ID (cgroup v2
 * `…/docker-<id>.scope`, v1 `/docker/<id>`), Podman's (`libpod-<id>`), containerd's — or `''`
 * for a container whose ID isn't there; null outside containers (the Docker and containerd
 * daemons themselves too).
 */
export function parseContainerId(cgroup: string): string | null {
  const id = /(?:docker|libpod|containerd)[-/]([0-9a-f]{64})/.exec(cgroup);
  if (id) return id[1];
  return CONTAINER_CGROUP.test(cgroup) ? '' : null;
}

/** `/etc/passwd`: uid → account name. */
export function parsePasswd(passwd: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of passwd.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid && /^\d+$/.test(uid) && !users.has(Number(uid))) users.set(Number(uid), name);
  }
  return users;
}

/** `btime` of `/proc/stat`: when the machine booted, in seconds since 1970. */
export function parseBootTime(stat: string): number | null {
  const match = /^btime\s+(\d+)/m.exec(stat);
  return match ? Number(match[1]) : null;
}

/**
 * Whether /proc hides other users' processes (`hidepid=1|2`, `invisible`, `noaccess` on its
 * mount in `/proc/self/mounts`): then the list is incomplete.
 */
export function procHidesProcesses(mounts: string): boolean {
  for (const line of mounts.split('\n')) {
    const [, mount, fsType, options = ''] = line.trim().split(/\s+/);
    if (mount !== '/proc' || fsType !== 'proc') continue;
    return options.split(',').some((option) => /^hidepid=(1|2|noaccess|invisible)$/.test(option));
  }
  return false;
}
