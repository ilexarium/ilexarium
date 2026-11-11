// Apps: Compose folders run as this account. Long work runs
// as a systemd unit — a user unit with the docker group, a system unit by ilex-root without it —
// so it goes on when the session or Ilexarium ends. Its output goes to a file in the app's folder,
// and systemd adds its result at the end (`@@ilex-result`, then SERVICE_RESULT, EXIT_CODE,
// EXIT_STATUS): what happened is in the file, whatever happens to the unit afterwards.

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BAD_REQUEST,
  ok,
  plainPath,
  refused,
  said,
  type Answer,
  type Request,
} from './answers.mts';
import {
  COMPOSE_ANSWER_MAX,
  COMPOSE_CONFIG_MAX,
  MESSAGE_MAX,
  TEMPLATE_LABEL,
  PROGRAMS,
  PROJECT_PATTERN,
  QUICK_TIMEOUT_MS,
  TASK_ACTIONS,
  TASK_END,
  UNIT_PATTERN,
  MESSAGES,
  VOLUME_PATTERN,
  type TaskAction,
} from './config.mts';
import { run } from './run.mts';
import { forward } from './sudo.mts';

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
  // This session's groups (its SSH login).
  const login = await run(PROGRAMS.id, ['-nG'], { timeoutMs: QUICK_TIMEOUT_MS });
  const loginGroups = login.code === 0 ? login.stdout.trim().split(/\s+/) : [];
  return ok({
    userUnits: result.code === 0,
    unitDocker: unitGroups.includes('docker'),
    loginDocker: loginGroups.includes('docker'),
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

/** `systemd-run` for a task: a user unit, or a system unit (`system`, run by ilex-root). */
function unitArgs(
  system: boolean,
  unit: string,
  dir: string,
  log: string,
  name: string,
  action: TaskAction,
) {
  return [
    ...(system ? [] : ['--user']),
    `--unit=${unit}`,
    '--collect',
    '--quiet',
    `--working-directory=${dir}`,
    `--property=StandardOutput=append:${log}`,
    `--property=StandardError=append:${log}`,
    `--property=ExecStopPost=${TASK_END.echo} @@ilex-result`,
    `--property=ExecStopPost=${TASK_END.printenv} SERVICE_RESULT EXIT_CODE EXIT_STATUS`,
    '--',
    PROGRAMS.docker,
    'compose',
    '--project-name',
    name,
    ...TASK_ACTIONS[action],
  ];
}

function task(request: Request): TaskAction | null {
  const action = request['task'];
  return typeof action === 'string' && Object.hasOwn(TASK_ACTIONS, action)
    ? (action as TaskAction)
    : null;
}

/**
 * Starts a task (`up`, `update`, `down`) in the app's folder: `docker compose -p <project> …` as
 * a unit, its output appended to `.ilex/tasks/<time>-<action>.log`, recorded in
 * `.ilex/task.json`. `system`: a system unit, started by ilex-root (the files stay this
 * account's).
 */
export async function startTask(request: Request): Promise<Answer> {
  const name = project(request);
  const dir = folder(request);
  const action = task(request);
  const system = request['system'];
  if (!name || !dir || !action || typeof system !== 'boolean') return BAD_REQUEST;
  const time = stamp();
  const unit = `ilex-app-${name}-${action}-${time}`;
  if (!UNIT_PATTERN.test(unit)) return BAD_REQUEST;
  const tasks = join(dir, '.ilex', 'tasks');
  const logName = `${time}-${action}.log`;
  const log = join(tasks, logName);
  try {
    mkdirSync(tasks, { recursive: true, mode: 0o700 });
    // Ours, so the person reads it; root's unit appends to it.
    writeFileSync(log, '', { flag: 'wx', mode: 0o600 });
  } catch {
    return refused('folder_not_writable');
  }
  const started = system
    ? await forward({ action: 'app.task', project: name, folder: dir, task: action, unit, log })
    : await runUnit(unitArgs(false, unit, dir, log, name, action));
  if (!started.ok) {
    // Nothing started: no log left behind (a try again a moment later gets the same name).
    rmSync(log, { force: true });
    return started;
  }
  const record = { unit, system, action, log: logName, startedAt: new Date().toISOString() };
  writeFileSync(join(dir, '.ilex', 'task.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return ok(record);
}

async function runUnit(args: string[]): Promise<Answer> {
  const result = await run(PROGRAMS.systemdRun, args, { timeoutMs: QUICK_TIMEOUT_MS });
  if (result.code === 0) return ok();
  if (result.timedOut) return refused('timed_out');
  return { ok: false, error: 'task_not_started', message: said(result) } as Answer;
}

/**
 * ilex-root's half of a system task: the unit, for a log the account made beforehand — the
 * unit's name and the log's path as `startTask` builds them.
 */
export async function startSystemTask(request: Request): Promise<Answer> {
  const name = project(request);
  const dir = folder(request);
  const action = task(request);
  const { unit, log } = request;
  if (!name || !dir || !action || typeof unit !== 'string' || typeof log !== 'string') {
    return BAD_REQUEST;
  }
  const time = /^ilex-app-.+-(\d{8}T\d{6})$/.exec(unit)?.[1];
  if (!time || unit !== `ilex-app-${name}-${action}-${time}` || !UNIT_PATTERN.test(unit)) {
    return BAD_REQUEST;
  }
  if (log !== join(dir, '.ilex', 'tasks', `${time}-${action}.log`) || !existsSync(log)) {
    return BAD_REQUEST;
  }
  return runUnit(unitArgs(true, unit, dir, log, name, action));
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

/** How Docker is run for a quick command: `direct` (the docker group) or `sudo` (ilex-root). */
function docker(request: Request): boolean | null {
  const how = request['docker'];
  return how === 'sudo' ? true : how === 'direct' ? false : null;
}

function dockerRefusal(result: Awaited<ReturnType<typeof run>>): Answer {
  if (result.timedOut) return refused('timed_out');
  if (result.missing) return refused('docker_unavailable');
  return { ok: false, error: 'compose_failed', message: said(result) } as Answer;
}

interface ComposeConfig {
  services?: Record<
    string,
    { volumes?: { type?: unknown; source?: unknown }[]; labels?: Record<string, unknown> } | null
  >;
  volumes?: Record<string, { name?: unknown; external?: unknown } | null>;
}

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/**
 * Compose's own check of the folder's files (`config --format json`, every profile; no daemon
 * needed, so never sudo). Of its answer only the mounts and the template label go back: the
 * filled-in file holds the app's secrets.
 */
export async function checkCompose(request: Request): Promise<Answer> {
  const name = project(request);
  const dir = folder(request);
  if (!name || !dir) return BAD_REQUEST;
  const result = await run(
    PROGRAMS.docker,
    ['compose', '--project-name', name, '--profile', '*', 'config', '--format', 'json'],
    { timeoutMs: QUICK_TIMEOUT_MS, cwd: dir, outputMax: COMPOSE_CONFIG_MAX },
  );
  if (result.code !== 0) {
    if (!result.timedOut && !result.missing) {
      // Its own words, within what the server reads of an answer.
      const message = said(result).slice(-MESSAGE_MAX);
      return { ok: false, error: 'compose_invalid', message } as Answer;
    }
    return dockerRefusal(result);
  }
  let config: ComposeConfig;
  try {
    config = JSON.parse(result.stdout) as ComposeConfig;
  } catch {
    return refused('failed');
  }
  const mounts: { type: string; source: string | null }[] = [];
  const templates: string[] = [];
  for (const service of Object.values(config.services ?? {})) {
    for (const volume of service?.volumes ?? []) {
      const type = text(volume?.type);
      if (type) mounts.push({ type, source: text(volume.source) });
    }
    const label = text(service?.labels?.[TEMPLATE_LABEL]);
    if (label) templates.push(label);
  }
  const answer = {
    mounts,
    volumes: Object.entries(config.volumes ?? {}).map(([key, volume]) => ({
      key,
      name: text(volume?.name),
      external: volume?.external === true,
    })),
    templates,
  };
  // Within what the server reads of one answer.
  if (JSON.stringify(answer).length > COMPOSE_ANSWER_MAX) return refused('too_large');
  return ok(answer);
}

/** Deletes an app's named volumes (after its removal; Docker refuses one still in use). */
export async function removeVolumes(request: Request): Promise<Answer> {
  const names = request['names'];
  const administrator = docker(request);
  if (administrator === null || !Array.isArray(names) || names.length === 0 || names.length > 50) {
    return BAD_REQUEST;
  }
  if (!names.every((n) => typeof n === 'string' && VOLUME_PATTERN.test(n))) return BAD_REQUEST;
  const result = await run(PROGRAMS.docker, ['volume', 'rm', '--', ...names], {
    timeoutMs: QUICK_TIMEOUT_MS,
  });
  if (result.code === 0) return ok();
  // Already gone (deleted by a try before, or never made — a service not started): fine.
  const errors = result.stderr.trim().split('\n').filter(Boolean);
  if (
    result.code !== null &&
    errors.length > 0 &&
    errors.every((l) => MESSAGES.noSuchVolume.test(l))
  ) {
    return ok();
  }
  return dockerRefusal(result);
}
