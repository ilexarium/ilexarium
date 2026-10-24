// process/proc.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Reading one process from /proc/<pid>: its own parsing, not shared with the app (the app's
// view of a process is never trusted here).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessInfo } from './model.mts';

/** PF_KTHREAD in /proc/<pid>/stat's flags (field 9): a kernel thread. */
export const PF_KTHREAD = 0x0020_0000;

/**
 * A container's cgroup: Docker's (`/docker/<id>`, `docker-<id>.scope`, rootless too), Podman's
 * (with or without systemd), containerd's (Kubernetes too), LXC's, systemd-nspawn's — not the
 * daemons' own services (`docker.service`, `containerd.service`). The app writes the same rule
 * (a test compares them); anything either side calls a container is one here.
 */
export const CONTAINER_CGROUP =
  /\/docker\/|(?:docker|libpod|containerd)[-/][0-9a-f]{64}|(?:docker|libpod|cri-containerd)-[^/\s]*\.scope|\/kubepods\b|\/lxc[./]|\/machine\.slice\//m;

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The process with this PID, or null (none, or it ended while being read). The name in
 * /proc/<pid>/stat sits in parentheses and may hold spaces and `)`: fields are counted from the
 * last `)` (field 3, state, comes right after it).
 */
export function readProcess(proc: string, pid: number): ProcessInfo | null {
  const stat = readOptional(join(proc, String(pid), 'stat'));
  const status = readOptional(join(proc, String(pid), 'status'));
  const cgroup = readOptional(join(proc, String(pid), 'cgroup'));
  if (stat === null || status === null || cgroup === null) return null;
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 1 || close < open || Number(stat.slice(0, open).trim()) !== pid) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const field = (n: number) => fields[n - 3] ?? '';
  const startTicks = field(22);
  const flags = Number(field(9));
  if (!/^\d+$/.test(startTicks) || !Number.isInteger(flags)) return null;
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!uids) return null;
  return {
    startTicks,
    flags,
    uids: uids.slice(1, 5).map(Number),
    inContainer: CONTAINER_CGROUP.test(cgroup),
  };
}
