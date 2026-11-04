// An update's job file, <state>/<id>.jsonl: one JSON event per line — its start, phases, the
// installer's output and its result. The app (its group may read it) follows it, also across its
// own restart; it holds no secrets.

import {
  appendFileSync,
  chmodSync,
  chownSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Config, Paths } from './model.mts';
import { isRoot } from '../lib/startup.mts';

const JOBS_KEPT = 20;
const LINES_MAX_BYTES = 512 * 1024;

export function prepareState(config: Config, paths: Paths): void {
  mkdirSync(paths.state, { recursive: true, mode: 0o750 });
  chmodSync(paths.state, 0o750);
  if (isRoot) chownSync(paths.state, 0, config.update.appGid!);
}

export class JobFile {
  private bytes = 0;
  readonly file: string;

  constructor(config: Config, paths: Paths, id: string, create: boolean) {
    this.file = join(paths.state, `${id}.jsonl`);
    if (!create) return;
    prune(paths.state);
    writeFileSync(this.file, '', { mode: 0o640, flag: 'wx' });
    // The program's umask (077) took the group's read away: the app follows this file.
    chmodSync(this.file, 0o640);
    if (isRoot) chownSync(this.file, 0, config.update.appGid!);
  }

  event(event: Record<string, unknown>): void {
    const line = `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`;
    if (event['type'] === 'line') {
      if (this.bytes + line.length > LINES_MAX_BYTES) return;
      this.bytes += line.length;
    }
    appendFileSync(this.file, line);
  }
}

function prune(dir: string): void {
  const jobs = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of jobs.slice(JOBS_KEPT - 1)) rmSync(old.path, { force: true });
}
