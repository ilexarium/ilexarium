// backup/files.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// Files this program writes: the live progress, the results, and its state.

import {
  appendFileSync,
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, Paths } from './model.mts';
import { isRoot } from '../lib/startup.mts';

/** Live progress: output lines stop being written past this size (the events still are). */
export const PROGRESS_MAX_BYTES = 1024 * 1024;

/** runs.jsonl is cut back to its last lines when it grows past this. */
export const RESULTS_MAX_BYTES = 8 * 1024 * 1024;

export const RESULTS_KEPT_LINES = 2000;

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

/** A file the app's group may read (progress and results): 0640, root:<app group>. */
export function shareWithApp(config: Config, file: string): void {
  chmodSync(file, 0o640);
  if (isRoot) chownSync(file, 0, config.backup.appGid!);
}

/**
 * The live progress of the run: one JSON event per line, started fresh each run. The app follows
 * it (scheduled and manual runs alike); it holds no secrets. Output lines stop past a size cap.
 */
export class Progress {
  private bytes = 0;
  private readonly file: string;

  constructor(config: Config, paths: Paths) {
    this.file = join(paths.state, 'current.jsonl');
    // A new file each run (not emptied in place): the app tells runs apart by the file itself.
    writeAtomic(this.file, '', 0o640, config.backup.appGid);
  }

  event(event: Record<string, unknown>): void {
    const line = `${JSON.stringify(event)}\n`;
    if (event['type'] === 'line' && this.bytes + line.length > PROGRESS_MAX_BYTES) return;
    this.bytes += line.length;
    appendFileSync(this.file, line);
  }
}

/** Appends one result (a run, a check) to runs.jsonl, keeping it from growing without end. */
export function appendResult(config: Config, paths: Paths, result: Record<string, unknown>): void {
  const file = join(paths.state, 'runs.jsonl');
  const line = `${JSON.stringify(result)}\n`;
  if (existsSync(file) && statSync(file).size + line.length > RESULTS_MAX_BYTES) {
    const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-RESULTS_KEPT_LINES);
    writeAtomic(file, `${kept.join('\n')}\n`, 0o640, config.backup.appGid);
  }
  appendFileSync(file, line, { mode: 0o640 });
  shareWithApp(config, file);
}

export const stamp = (date = new Date()) => date.toISOString().slice(0, 19);

export const folderStamp = (date = new Date()) =>
  date.toISOString().slice(0, 19).replace(/-/g, '').replace(/:/g, '').replace('T', '-');
