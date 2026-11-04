// The new release's installer (install.sh --update), its @@ lines read as its progress: how far
// it got decides what a rollback has to undo.

import { join } from 'node:path';
import type { JobFile } from './job.mts';
import type { Programs } from './model.mts';
import { runProgram } from './programs.mts';
import { emit } from '../lib/output.mts';

export const INSTALL_PHASES = ['checked', 'saved', 'stopped', 'migrated', 'installed', 'started'];
const INSTALL_TIMEOUT_MS = 30 * 60_000;

export interface Progress {
  phases: Set<string>;
  dump: string | null;
}

export async function runInstaller(
  programs: Programs,
  release: string,
  job: JobFile,
): Promise<{ code: number; progress: Progress }> {
  const progress: Progress = { phases: new Set(), dump: null };
  const code = await runProgram(programs.bash, [join(release, 'install.sh'), '--update'], {
    cwd: release,
    timeoutMs: INSTALL_TIMEOUT_MS,
    onLine: (line) => {
      const phase = /^@@phase (\w+)$/.exec(line)?.[1];
      const dump = /^@@dump (.+)$/.exec(line)?.[1];
      if (phase && INSTALL_PHASES.includes(phase)) {
        progress.phases.add(phase);
        job.event({ type: 'phase', phase });
        emit(`@@phase ${phase}`);
      } else if (dump) {
        progress.dump = dump;
      } else {
        job.event({ type: 'line', text: line });
        emit(`> ${line}`);
      }
    },
  });
  return { code, progress };
}

/** Whether the app answers its health check as `version` within `timeoutMs`. */
export async function answersAs(url: string, version: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body = (await response.json()) as { version?: unknown };
      if (response.ok && body.version === version) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}
