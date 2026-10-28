import { Injectable } from '@nestjs/common';
import type { AppTask, AppTaskAction } from '@laris/shared';
import { posix } from 'node:path';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { AppSftp } from './app-sftp.js';
import { helperError } from './app-errors.js';
import {
  QUICK_MS,
  TASK_FILE,
  TASK_READ_BYTES,
  TASK_RESULT_MARKER,
  TASKS_DIR,
} from './apps.constants.js';
import type { DockerAccess, TaskRecord } from './apps.model.js';

/** Terminal colours and carriage returns: the log is shown as plain lines. */
// oxlint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

/** The end of a task's log: the marker systemd adds, then SERVICE_RESULT, EXIT_CODE, EXIT_STATUS. */
export function taskResult(tail: string): { succeeded: boolean } | null {
  const lines = tail.split('\n');
  const at = lines.lastIndexOf(TASK_RESULT_MARKER);
  if (at < 0) return null;
  return { succeeded: lines[at + 1]?.trim() === 'success' };
}

/** Output lines, the result lines left out. */
export function taskLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(CONTROL, ''));
  const at = lines.indexOf(TASK_RESULT_MARKER);
  return at >= 0 ? lines.slice(0, at) : lines;
}

/**
 * Long tasks of apps (install, change, update, removal) as systemd units started by the helper
 * (docs/plans/acting_as_you.md): with the docker group a user unit, without it a system unit
 * through the account's sudo. Their output and result are read back from the app's folder.
 */
@Injectable()
export class AppTasks {
  private readonly access = new Map<string, { at: number; access: DockerAccess }>();

  constructor(
    private readonly linuxSessions: LinuxSessions,
    private readonly changesUnderway: ChangesUnderway,
  ) {}

  /** How this account runs Docker (asked once a minute at most). */
  async dockerAccess(appSessionId: string): Promise<DockerAccess> {
    const cached = this.access.get(appSessionId);
    if (cached && Date.now() - cached.at < 60_000) return cached.access;
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'docker.access' },
      { timeoutMs: QUICK_MS },
    );
    if (!answer.ok) throw helperError(answer);
    const userUnits = answer['userUnits'] === true;
    const unitDocker = answer['unitDocker'] === true;
    const loginDocker = answer['loginDocker'] === true;
    const access: DockerAccess = {
      system: !(userUnits && unitDocker),
      quick: loginDocker ? 'direct' : 'sudo',
      restartNeeded: userUnits && loginDocker && !unitDocker,
    };
    this.access.set(appSessionId, { at: Date.now(), access });
    for (const [key, entry] of this.access) {
      if (Date.now() - entry.at > 60_000) this.access.delete(key);
    }
    return access;
  }

  async start(
    appSessionId: string,
    folder: string,
    project: string,
    task: AppTaskAction,
  ): Promise<AppTask> {
    const access = await this.dockerAccess(appSessionId);
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'app.task', folder, project, task, system: access.system },
      { sudo: access.system, timeoutMs: QUICK_MS },
    );
    if (!answer.ok) throw helperError(answer);
    this.changesUnderway.appTask(project);
    return {
      action: task,
      state: 'running',
      startedAt: String(answer['startedAt']),
      system: access.system,
      output: [],
      next: 0,
    };
  }

  /** Compose's own check of the folder's files: a 400 `compose_invalid` with what it said. */
  async check(appSessionId: string, folder: string, project: string): Promise<void> {
    const access = await this.dockerAccess(appSessionId);
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'compose.check', folder, project, docker: access.quick },
      { sudo: access.quick === 'sudo', timeoutMs: QUICK_MS },
    );
    if (!answer.ok) throw helperError(answer);
  }

  /** The app's latest task, its output from byte `from` on; null when it never had one. */
  async read(
    appSessionId: string,
    sftp: AppSftp,
    folder: string,
    from = 0,
  ): Promise<AppTask | null> {
    const recordText = await sftp.readText(posix.join(folder, TASK_FILE), 4096).catch(() => null);
    if (!recordText) return null;
    let record: TaskRecord;
    try {
      record = JSON.parse(recordText) as TaskRecord;
    } catch {
      return null;
    }
    if (!/^[\w.-]+\.log$/.test(record.log)) return null;
    const log = posix.join(folder, TASKS_DIR, record.log);
    const size = (await sftp.stat(log))?.size ?? 0;
    const tail = (await sftp.read(log, 512, Math.max(0, size - 512)))?.toString('utf8') ?? '';
    const result = taskResult(tail);
    const start = Math.min(from, size);
    const chunk = (await sftp.read(log, TASK_READ_BYTES, start)) ?? Buffer.alloc(0);
    // Whole lines only, unless it's done (the last line then has no break of its own).
    const lastBreak = chunk.lastIndexOf(0x0a);
    const whole = result || start + chunk.length >= size ? chunk : chunk.subarray(0, lastBreak + 1);
    const text = whole.toString('utf8');
    let state: AppTask['state'];
    if (result) state = result.succeeded ? 'succeeded' : 'failed';
    else {
      const answer = await this.linuxSessions.ask(
        appSessionId,
        { action: 'app.taskState', unit: record.unit, system: record.system },
        { timeoutMs: QUICK_MS },
      );
      const active = answer.ok ? String(answer['active']) : 'unknown';
      state = ['active', 'activating', 'reloading'].includes(active) ? 'running' : 'interrupted';
    }
    // Past the result: nothing more to show.
    const markerAt = result
      ? size -
        Buffer.byteLength(tail) +
        Buffer.byteLength(tail.slice(0, tail.lastIndexOf(TASK_RESULT_MARKER)))
      : size;
    const lines = start >= markerAt ? [] : taskLines(text);
    if (lines.at(-1) === '') lines.pop();
    return {
      action: record.action,
      state,
      startedAt: record.startedAt,
      system: record.system,
      output: lines,
      next: result ? size : start + whole.length,
    };
  }
}
