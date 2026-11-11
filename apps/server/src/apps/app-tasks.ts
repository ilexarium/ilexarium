import { Injectable } from '@nestjs/common';
import { type AppTask, type AppTaskAction, TEMPLATE_LABEL_PATTERN } from '@ilex/shared';
import { posix } from 'node:path';
import { ChangesUnderway } from '../jobs/changes-underway.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import type { Sftp } from '../linux-sessions/sftp.js';
import { helperError } from './app-errors.js';
import {
  DOCKER_ACCESS_CACHE_MS,
  LOG_CONTROL,
  QUICK_MS,
  TASK_FILE,
  TASK_RESULT_MARKER,
  TASK_TAIL_BYTES,
  TASKS_DIR,
} from './apps.constants.js';
import type { ComposeCheckAnswer, ComposeFacts, DockerAccess, TaskRecord } from './apps.model.js';

/** The end of a task's log: the marker systemd adds, then SERVICE_RESULT, EXIT_CODE, EXIT_STATUS. */
export function taskResult(tail: string): { succeeded: boolean } | null {
  const lines = tail.split('\n');
  const at = lines.lastIndexOf(TASK_RESULT_MARKER);
  if (at < 0) return null;
  return { succeeded: lines[at + 1]?.trim() === 'success' };
}

/** Output lines, the result lines left out. */
export function taskLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(LOG_CONTROL, ''));
  const at = lines.indexOf(TASK_RESULT_MARKER);
  return at >= 0 ? lines.slice(0, at) : lines;
}

/** The bind mounts and the named volumes (by Docker's name), from Compose's answer. */
export function composeFacts(answer: ComposeCheckAnswer, project: string): ComposeFacts {
  const folders = new Set<string>();
  const named = new Set<string>();
  for (const mount of answer.mounts) {
    if (mount.source === null) continue; // an anonymous volume
    // Compose gives absolute paths; anything else isn't a folder to touch.
    if (mount.type === 'bind' && mount.source.startsWith('/'))
      folders.add(posix.resolve(mount.source));
    else if (mount.type === 'volume') named.add(mount.source);
  }
  const volumes: string[] = [];
  for (const key of named) {
    const volume = answer.volumes.find((v) => v.key === key);
    if (volume?.external) continue;
    volumes.push(volume?.name ?? `${project}_${key}`);
  }
  const label = answer.templates.map((t) => TEMPLATE_LABEL_PATTERN.exec(t)).find(Boolean);
  return {
    folders: [...folders].sort(),
    volumes: volumes.sort(),
    template: label ? { id: label[1], version: label[2] } : null,
  };
}

/**
 * Long tasks of apps (install, change, update, removal) as systemd units started by the helper:
 * with the docker group a user unit, without it a system unit
 * through the account's sudo. Their output and result are read back from the app's folder.
 */
@Injectable()
export class AppTasks {
  private readonly access = new Map<string, { at: number; access: DockerAccess }>();

  constructor(
    private readonly linuxSessions: LinuxSessions,
    private readonly changesUnderway: ChangesUnderway,
  ) {}

  /** How this account runs Docker (asked once a minute at most, per account signed in). */
  async dockerAccess(appSessionId: string): Promise<DockerAccess> {
    // Another account signed in meanwhile has its own groups.
    const key = `${appSessionId}\n${this.linuxSessions.account(appSessionId).username}`;
    const cached = this.access.get(key);
    if (cached && Date.now() - cached.at < DOCKER_ACCESS_CACHE_MS) return cached.access;
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
    this.access.set(key, { at: Date.now(), access });
    for (const [old, entry] of this.access) {
      if (Date.now() - entry.at > DOCKER_ACCESS_CACHE_MS) this.access.delete(old);
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
    };
  }

  /**
   * Compose's own check of the folder's files (as the person: it needs no Docker daemon), and
   * what they mount: a 400 `compose_invalid` with what Compose said.
   */
  async check(appSessionId: string, folder: string, project: string): Promise<ComposeFacts> {
    const answer = await this.linuxSessions.ask(
      appSessionId,
      { action: 'compose.check', folder, project },
      { timeoutMs: QUICK_MS },
    );
    if (!answer.ok) throw helperError(answer);
    return composeFacts(answer as unknown as ComposeCheckAnswer, project);
  }

  /** The app's latest task, the end of its output; null when it never had one. */
  async read(appSessionId: string, sftp: Sftp, folder: string): Promise<AppTask | null> {
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
    const size = (await sftp.statOrNull(log))?.size ?? 0;
    const start = Math.max(0, size - TASK_TAIL_BYTES);
    let tail = ((await sftp.read(log, TASK_TAIL_BYTES, start)) ?? Buffer.alloc(0)).toString('utf8');
    // Cut into a line: from the next one.
    if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1);
    const result = taskResult(tail);
    let state: AppTask['state'];
    if (result) state = result.succeeded ? 'succeeded' : 'failed';
    else {
      const answer = await this.linuxSessions.ask(
        appSessionId,
        { action: 'app.taskState', unit: record.unit, system: record.system },
        { timeoutMs: QUICK_MS },
      );
      const active = answer.ok ? String(answer['active']) : 'unknown';
      // A check that timed out (a busy machine: an image extracting) says nothing — only a unit
      // that ended without its result was interrupted.
      const unanswered = !answer.ok && answer.error === 'timed_out';
      state =
        unanswered || ['active', 'activating', 'reloading'].includes(active)
          ? 'running'
          : 'interrupted';
    }
    // While it runs, whole lines only (the last may be half written).
    const output = taskLines(
      state === 'running' ? tail.slice(0, tail.lastIndexOf('\n') + 1) : tail,
    );
    if (output.at(-1) === '') output.pop();
    return {
      action: record.action,
      state,
      startedAt: record.startedAt,
      system: record.system,
      output,
    };
  }
}
