// backup/files.mts — runs as root.
//
// Files this program writes: the jobs' files, and its state.

import {
  appendFileSync,
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, Paths } from './model.mts';
import { isRoot } from '../lib/startup.mts';

/** A job's output lines stop being written past this size (its events still are). */
export const JOB_LINES_MAX_BYTES = 1024 * 1024;

/** Job files kept; older ones go when a new job starts (months of them: the app may be down a while). */
export const JOBS_KEPT = 500;

/** Writes a file whole (a crash never leaves half of it), owned by root (and the app's group). */
export function writeAtomic(path: string, content: string, mode: number, gid?: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode, flag: 'w' });
  chmodSync(temporary, mode);
  if (isRoot) chownSync(temporary, 0, gid ?? 0);
  renameSync(temporary, path);
}

/** The state folder: root's, readable by the app's group; Borg's own folder root-only. */
export function prepareState(config: Config, paths: Paths): void {
  mkdirSync(paths.state, { recursive: true, mode: 0o750 });
  chmodSync(paths.state, 0o750);
  if (isRoot) chownSync(paths.state, 0, config.backup.appGid!);
  mkdirSync(join(paths.state, 'borg'), { recursive: true, mode: 0o700 });
}

/** A file (or folder) the app's group may read (progress and results): 0640, root:<app group>. */
export function shareWithApp(config: Config, file: string, mode = 0o640): void {
  chmodSync(file, mode);
  if (isRoot) chownSync(file, 0, config.backup.appGid!);
}

/**
 * A job's file (a run, a check, a restore): `<state>/jobs/<id>.jsonl`, one JSON event per line —
 * its start, its progress and output, and its result at the end. The only way anything reaches
 * the app, which follows the folder; it holds no secrets. Output lines stop past a size cap.
 */
export class JobFile {
  private bytes = 0;
  private readonly file: string;

  constructor(config: Config, paths: Paths, id: string) {
    const dir = join(paths.state, 'jobs');
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    shareWithApp(config, dir, 0o750);
    pruneJobs(dir);
    this.file = join(dir, `${id}.jsonl`);
    writeAtomic(this.file, '', 0o640, config.backup.appGid);
  }

  event(event: Record<string, unknown>): void {
    const line = `${JSON.stringify(event)}\n`;
    if (event['type'] === 'line') {
      if (this.bytes + line.length > JOB_LINES_MAX_BYTES) return;
      this.bytes += line.length;
    }
    this.append(line, false);
  }

  /** On the disk before going on: it must outlive a power loss (what a restore has moved). */
  syncedEvent(event: Record<string, unknown>): void {
    this.append(`${JSON.stringify(event)}\n`, true);
  }

  private append(line: string, sync: boolean): void {
    if (!sync) return appendFileSync(this.file, line);
    const fd = openSync(this.file, 'a');
    try {
      appendFileSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** The oldest job files go, so the folder never grows without end. */
function pruneJobs(dir: string): void {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of files.slice(JOBS_KEPT - 1)) rmSync(old.path, { force: true });
}

export const stamp = (date = new Date()) => date.toISOString().slice(0, 19);

export const folderStamp = (date = new Date()) =>
  date.toISOString().slice(0, 19).replace(/-/g, '').replace(/:/g, '').replace('T', '-');
