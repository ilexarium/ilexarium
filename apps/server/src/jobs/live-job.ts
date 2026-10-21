import type { Job, JobPhase } from '@laris/shared';
import type { JobRow } from './jobs.model.js';

/** Output kept per job (the end matters most when something failed). */
export const MAX_JOB_OUTPUT_BYTES = 256 * 1024;

/** The running job's phase and newest output lines, in memory until it's saved. */
export class LiveJob {
  /** Null while the request is still being checked (the slot is already claimed). */
  id: string | null = null;
  phase: JobPhase | null = null;
  /** The newest lines, at most MAX_JOB_OUTPUT_BYTES. */
  readonly lines: string[] = [];
  private bytes = 0;
  /** Lines dropped from the start to stay within the limit. */
  omitted = 0;

  append(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line) + 1;
    while (this.bytes > MAX_JOB_OUTPUT_BYTES && this.lines.length > 1) {
      this.bytes -= Buffer.byteLength(this.lines.shift()!) + 1;
      this.omitted++;
    }
  }

  /** The output as it's saved: a note on dropped lines, then the kept ones. */
  savedOutput(): string {
    return [
      ...(this.omitted > 0 ? [`[… ${this.omitted} earlier lines not kept]`] : []),
      ...this.lines,
    ].join('\n');
  }
}

/** A job as the API and the topics show it — live from memory while it runs; the last `lastLines` lines if given. */
export function jobView(row: JobRow, live: LiveJob | null, lastLines?: number): Job {
  const running = live?.id === row.id ? live : null;
  const lines = running ? running.lines : row.output ? row.output.split('\n') : [];
  const shown = lastLines === undefined ? lines : lines.slice(-lastLines);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    phase: ((running ? running.phase : row.phase) ?? null) as JobPhase | null,
    errorCode: row.errorCode,
    errorField: row.errorField,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    output: shown,
    omitted: lines.length - shown.length + (running ? running.omitted : 0),
  };
}
