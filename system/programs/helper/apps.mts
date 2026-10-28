// Apps (docs/plans/acting_as_you.md, "Apps"): Compose folders run as this account. Long work runs
// as a systemd unit — a user unit with the docker group, a system unit through sudo without it —
// so it goes on when the session or Laris ends. Its output goes to a file in the app's folder,
// and systemd adds its result at the end (`@@laris-result`, then SERVICE_RESULT, EXIT_CODE,
// EXIT_STATUS): what happened is in the file, whatever happens to the unit afterwards.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import {
  BAD_REQUEST,
  ok,
  plainPath,
  refused,
  runAs,
  said,
  sudoRefusal,
  type Answer,
  type Request,
} from './answers.mts';
import {
  PROGRAMS,
  PROJECT_PATTERN,
  QUICK_TIMEOUT_MS,
  TASK_ACTIONS,
  TASK_END,
  UNIT_PATTERN,
  VOLUME_PATTERN,
  type TaskAction,
} from './config.mts';
import { run } from './run.mts';

/** The groups this account has now (its SSH login) — by number, from /etc/group (no program). */
function loginGroups(): Set<string> {
  const own = new Set(process.getgroups?.() ?? []);
  const names = new Set<string>();
  try {
    for (const line of readFileSync('/etc/group', 'utf8').split('\n')) {
      const [name, , gid, members] = line.split(':');
      if (!name) continue;
      if (own.has(Number(gid)) || (members ?? '').split(',').includes(userInfo().username)) {
        names.add(name);
      }
    }
  } catch {
    // no /etc/group: no groups known
  }
  return names;
}

/**
 * Whether Docker can be used without sudo: in a user unit (`id -nG` there — a user systemd keeps
 * the groups it started with) and in this session. No user systemd at all: `userUnits` false.
 */
export async function dockerAccess(): Promise<Answer> {
  const result = await run(
    PROGRAMS.systemdRun,
    ['--user', '--wait', '--pipe', '--quiet', '--collect', '--', PROGRAMS.id, '-nG'],
    { timeoutMs: QUICK_TIMEOUT_MS },
  );
  const unitGroups = result.code === 0 ? result.stdout.trim().split(/\s+/) : [];
  return ok({
    userUnits: result.code === 0,
    unitDocker: unitGroups.includes('docker'),
    loginDocker: loginGroups().has('docker'),
  });
}

function project(request: Request): string | null {
  const name = request['project'];
  return typeof name === 'string' && PROJECT_PATTERN.test(name) ? name : null;
}

function folder(request: Request): string | null {
  const path = request['folder'];
  if (!plainPath(path)) return null;
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

const stamp = (date = new Date()) => date.toISOString().slice(0, 19).replace(/[-:]/g, '');

/**
 * Starts a task (`up`, `update`, `down`) in the app's folder: `docker compose -p <project> …` as
 * a unit, its output appended to `.laris/tasks/<time>-<action>.log`, recorded in
 * `.laris/task.json`. `system`: a system unit through sudo -n.
 */
export async function startTask(request: Request): Promise<Answer> {
  const name = project(request);
  const dir = folder(request);
  const action = request['task'];
  const system = request['system'];
  if (!name || !dir || typeof system !== 'boolean') return BAD_REQUEST;
  if (typeof action !== 'string' || !Object.hasOwn(TASK_ACTIONS, action)) return BAD_REQUEST;
  const time = stamp();
  const unit = `laris-app-${name}-${action}-${time}`;
  if (!UNIT_PATTERN.test(unit)) return BAD_REQUEST;
  const tasks = join(dir, '.laris', 'tasks');
  const logName = `${time}-${action}.log`;
  const log = join(tasks, logName);
  try {
    mkdirSync(tasks, { recursive: true, mode: 0o700 });
    // Ours, so the person reads it; root's unit appends to it.
    writeFileSync(log, '', { flag: 'wx', mode: 0o600 });
  } catch {
    return refused('folder_not_writable');
  }
  const args = [
    ...(system ? [] : ['--user']),
    `--unit=${unit}`,
    '--collect',
    '--quiet',
    `--working-directory=${dir}`,
    `--property=StandardOutput=append:${log}`,
    `--property=StandardError=append:${log}`,
    `--property=ExecStopPost=${TASK_END.echo} @@laris-result`,
    `--property=ExecStopPost=${TASK_END.printenv} SERVICE_RESULT EXIT_CODE EXIT_STATUS`,
    '--',
    PROGRAMS.docker,
    'compose',
    '--project-name',
    name,
    ...TASK_ACTIONS[action as TaskAction],
  ];
  const result = await runAs(system, PROGRAMS.systemdRun, args, { timeoutMs: QUICK_TIMEOUT_MS });
  if (result.code !== 0) {
    // Nothing started: no log left behind (a try again a moment later gets the same name).
    rmSync(log, { force: true });
    if (result.timedOut) return refused('timed_out');
    if (system) {
      const refusal = sudoRefusal(result);
      if (refusal) return refused(refusal);
    }
    return { ok: false, error: 'task_not_started', message: said(result) } as Answer;
  }
  const task = { unit, system, action, log: logName, startedAt: new Date().toISOString() };
  writeFileSync(join(dir, '.laris', 'task.json'), `${JSON.stringify(task)}\n`, { mode: 0o600 });
  return ok(task);
}

/** Whether a task's unit still runs (`systemctl [--user] is-active`; reading needs no sudo). */
export async function taskState(request: Request): Promise<Answer> {
  const unit = request['unit'];
  const system = request['system'];
  if (typeof unit !== 'string' || !UNIT_PATTERN.test(unit) || typeof system !== 'boolean') {
    return BAD_REQUEST;
  }
  const result = await run(
    PROGRAMS.systemctl,
    [...(system ? [] : ['--user']), 'is-active', '--', `${unit}.service`],
    { timeoutMs: QUICK_TIMEOUT_MS },
  );
  if (result.timedOut) return refused('timed_out');
  return ok({ active: result.stdout.trim().split('\n')[0] ?? 'unknown' });
}

/** How Docker is run for a quick command: `direct` (the docker group) or `sudo`. */
function docker(request: Request): boolean | null {
  const how = request['docker'];
  return how === 'sudo' ? true : how === 'direct' ? false : null;
}

function dockerRefusal(administrator: boolean, result: Awaited<ReturnType<typeof run>>): Answer {
  if (result.timedOut) return refused('timed_out');
  if (result.missing && !existsSync(PROGRAMS.docker)) return refused('docker_unavailable');
  if (administrator) {
    const refusal = sudoRefusal(result);
    if (refusal) return refused(refusal);
  }
  if (result.missing) return refused('docker_unavailable');
  return { ok: false, error: 'compose_failed', message: said(result) } as Answer;
}

/** `docker compose config --quiet`: Compose's own check of the folder's files. */
export async function checkCompose(request: Request): Promise<Answer> {
  const name = project(request);
  const dir = folder(request);
  const administrator = docker(request);
  if (!name || !dir || administrator === null) return BAD_REQUEST;
  const result = await runAs(
    administrator,
    PROGRAMS.docker,
    ['compose', '--project-name', name, 'config', '--quiet'],
    { timeoutMs: QUICK_TIMEOUT_MS, cwd: dir },
  );
  if (result.code === 0) return ok();
  if (!result.timedOut && !result.missing && !(administrator && sudoRefusal(result))) {
    return { ok: false, error: 'compose_invalid', message: said(result) } as Answer;
  }
  return dockerRefusal(administrator, result);
}

/** The images an app's containers run, with their digests (saved before an update). */
export async function composeImages(request: Request): Promise<Answer> {
  const name = project(request);
  const dir = folder(request);
  const administrator = docker(request);
  if (!name || !dir || administrator === null) return BAD_REQUEST;
  const listed = await runAs(
    administrator,
    PROGRAMS.docker,
    ['compose', '--project-name', name, 'images', '--format', 'json'],
    { timeoutMs: QUICK_TIMEOUT_MS, cwd: dir },
  );
  if (listed.code !== 0) return dockerRefusal(administrator, listed);
  let rows: { ContainerName?: unknown; Repository?: unknown; Tag?: unknown; ID?: unknown }[];
  try {
    const parsed: unknown = JSON.parse(listed.stdout || '[]');
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return refused('failed');
  }
  const images = [];
  for (const row of rows) {
    const id = String(row.ID ?? '');
    if (!/^(sha256:)?[0-9a-f]{12,64}$/.test(id)) continue;
    const inspected = await runAs(
      administrator,
      PROGRAMS.docker,
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', '--', id],
      { timeoutMs: QUICK_TIMEOUT_MS },
    );
    let digests: string[] = [];
    try {
      const parsed: unknown = JSON.parse(inspected.stdout.trim() || '[]');
      if (Array.isArray(parsed)) digests = parsed.filter((d) => typeof d === 'string');
    } catch {
      // no digests known (an image built here)
    }
    images.push({
      container: String(row.ContainerName ?? ''),
      repository: String(row.Repository ?? ''),
      tag: String(row.Tag ?? ''),
      digests,
    });
  }
  return ok({ images });
}

/** Deletes an app's named volumes (after its removal; Docker refuses one still in use). */
export async function removeVolumes(request: Request): Promise<Answer> {
  const names = request['names'];
  const administrator = docker(request);
  if (administrator === null || !Array.isArray(names) || names.length === 0 || names.length > 50) {
    return BAD_REQUEST;
  }
  if (!names.every((n) => typeof n === 'string' && VOLUME_PATTERN.test(n))) return BAD_REQUEST;
  const result = await runAs(administrator, PROGRAMS.docker, ['volume', 'rm', '--', ...names], {
    timeoutMs: QUICK_TIMEOUT_MS,
  });
  return result.code === 0 ? ok() : dockerRefusal(administrator, result);
}
