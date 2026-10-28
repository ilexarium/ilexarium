// backup/run.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// `run-requested` and `run-scheduled`: back up every item of the plan (or one), each into its own
// archive.

import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openRepository } from './destination.mts';
import { appendResult, prepareState, Progress, stamp } from './files.mts';
import type {
  Config,
  ItemKind,
  ItemResult,
  Paths,
  Plan,
  PlanItem,
  Ran,
  Repository,
} from './model.mts';
import { allowedFolder, overlaps, resolveSource } from './places.mts';
import { ARCHIVE_PATTERN, loadPlan } from './plan.mts';
import { borg, borgFailure, docker, sleep, stopping, takeLock } from './programs.mts';
import { emit, oneLine, Refusal } from '../lib/output.mts';

/** The platform's sessions are left out of its database dump (signing in again is fine). */
export const SESSIONS_TABLE = '"Session"';

export const RESTART_ATTEMPTS = 3;

export const RESULT_OUTPUT_LINES = 200;

export const MAX_WARNINGS = 20;

export const ORDER: Record<ItemKind, number> = { platform: 0, app: 1, folder: 2 };

export async function run(
  config: Config,
  paths: Paths,
  trigger: 'scheduled' | 'manual',
  runId: string,
  onlyItem: string | null,
): Promise<number> {
  const startedAt = new Date().toISOString();
  // A run refused before it starts is recorded all the same: nobody waits on this program's
  // output (a timer or "Back up now" started it), so the app learns it only from runs.jsonl.
  const refused = (error: unknown): unknown => {
    if (!(error instanceof Refusal)) return error;
    prepareState(config, paths);
    appendResult(config, paths, {
      type: 'run',
      runId,
      trigger,
      itemId: onlyItem,
      status: 'failed',
      errorCode: error.code,
      startedAt,
      finishedAt: new Date().toISOString(),
      items: [],
      output: [
        error.code === 'busy'
          ? 'Another operation held the lock; this run was skipped.'
          : oneLine(error.message),
      ],
    });
    return error;
  };
  let release: () => void;
  try {
    // A scheduled run waits a while for another operation (an install, a long check).
    release = await takeLock(paths, trigger === 'scheduled');
  } catch (error) {
    throw refused(error);
  }
  // The plan as it is now — read only once the lock is ours (it may have changed meanwhile).
  let plan: Plan;
  let items: PlanItem[];
  try {
    plan = loadPlan(config, paths);
    items = plan.items
      .filter((item) => !item.removed && (onlyItem === null || item.id === onlyItem))
      .sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    if (onlyItem !== null && items.length === 0) {
      throw new Refusal('item_not_found', 'no such item in the plan');
    }
  } catch (error) {
    try {
      throw refused(error);
    } finally {
      release();
    }
  }
  const output: string[] = [];
  const results: ItemResult[] = [];
  let runError: string | null = null;
  let progress: Progress | null = null;
  try {
    prepareState(config, paths);
    progress = new Progress(config, paths);
    progress.event({
      type: 'run',
      runId,
      trigger,
      itemId: onlyItem,
      pid: process.pid,
      startedAt,
      items: items.map((item) => item.id),
    });
    let repo: Repository | null = null;
    try {
      repo = openRepository(config, paths, plan);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      runError = error.code;
      emit(`@@info ${oneLine(error.message)}`);
      output.push(error.message);
    }
    if (repo) {
      for (const item of items) {
        if (stopping) break;
        const keep = (line: string) => {
          output.push(line);
          if (output.length > RESULT_OUTPUT_LINES) output.shift();
          progress!.event({ type: 'line', itemId: item.id, text: line.slice(0, 2000) });
        };
        const result = await backupItem(
          config,
          paths,
          plan,
          repo,
          item,
          (phase) => {
            progress!.event({ type: 'item', itemId: item.id, phase });
          },
          keep,
        );
        results.push(result);
        progress.event({ type: 'itemDone', result: { ...result, archives: undefined } });
        if (
          result.errorCode &&
          ['passphrase_invalid', 'repository_mismatch'].includes(result.errorCode)
        ) {
          runError = result.errorCode; // the rest would fail the same way
          break;
        }
      }
      if (results.some((r) => r.archive !== null)) {
        const compact = await borg(config, paths, 'compact', [repo.path]);
        if (compact.code !== 0) output.push('borg compact failed');
      }
    }
    if (stopping) runError ??= 'interrupted';
  } catch (error) {
    // Unexpected (a file that couldn't be written): still recorded as a failed run below.
    runError ??= 'internal';
    emit(`@@info unexpected error: ${oneLine(String((error as Error)?.message ?? error))}`);
  }
  const failed = runError !== null || results.some((r) => r.status === 'failed');
  const status = failed ? 'failed' : results.some((r) => r.status === 'warning') ? 'warning' : 'ok';
  const finishedAt = new Date().toISOString();
  try {
    progress?.event({ type: 'done', runId, status, errorCode: runError, finishedAt });
    appendResult(config, paths, {
      type: 'run',
      runId,
      trigger,
      itemId: onlyItem,
      status,
      errorCode: runError,
      startedAt,
      finishedAt,
      items: results,
      output,
    });
  } finally {
    release();
  }
  emit(`@@result ${JSON.stringify({ runId, status, errorCode: runError })}`);
  if (runError) emit(`@@error code=${runError}`);
  if (stopping) return 143;
  return failed ? 5 : 0;
}

export async function backupItem(
  config: Config,
  paths: Paths,
  plan: Plan,
  repo: Repository,
  item: PlanItem,
  phase: (phase: string) => void,
  keep: (line: string) => void,
): Promise<ItemResult> {
  const result: ItemResult = {
    itemId: item.id,
    status: 'failed',
    errorCode: null,
    archive: null,
    originalBytes: null,
    addedBytes: null,
    warnings: [],
    archives: null,
  };
  const fail = (code: string, why: string) => {
    result.status = 'failed';
    result.errorCode ??= code;
    keep(why);
    return result;
  };
  try {
    let sources: string[] = [];
    const excludes: string[] = [];
    let project: string | null = null;
    let dumpDir: string | null = null;

    if (item.kind === 'platform') {
      phase('dumping');
      dumpDir = join(paths.state, 'platform');
      mkdirSync(dumpDir, { recursive: true, mode: 0o700 });
      const dumpFile = join(dumpDir, `${config.backup.platform.database}.dump`);
      const fd = openSync(dumpFile, 'w', 0o600);
      const { container, database, user } = config.backup.platform;
      let dump: Ran;
      try {
        // Inside the database's own container (its own pg_dump, its local socket).
        dump = await docker(
          config,
          [
            'exec',
            container,
            'pg_dump',
            `--username=${user}`,
            `--dbname=${database}`,
            '--format=custom',
            `--exclude-table-data=${SESSIONS_TABLE}`,
          ],
          { stdoutFd: fd, onLine: keep },
        );
      } finally {
        closeSync(fd);
      }
      if (dump.code !== 0) {
        rmSync(dumpDir, { recursive: true, force: true });
        return fail('dump_failed', 'the database dump failed');
      }
      sources = [dumpDir, ...config.backup.platform.files.filter((file) => existsSync(file))];
    } else if (item.kind === 'app') {
      for (const path of item.folders ?? []) {
        const real = resolveSource(path, (p) => allowedFolder(config, p));
        if (!real || overlaps(real, plan.destination)) {
          return fail('source_missing', `${path}: missing or not allowed`);
        }
        sources.push(real);
        for (const skip of item.skip ?? []) {
          if (!skip.startsWith(`${path}/`)) continue;
          // Below the folder as it really is (a symlink above it resolved).
          const inside = `${real}${skip.slice(path.length)}`;
          excludes.push('--exclude', /[*?]/.test(inside) ? `sh:${inside}` : `pp:${inside}`);
        }
      }
      // A `stop` app, by its project name: Compose finds its containers by their labels.
      if (item.mode === 'stop') project = item.project!;
    } else {
      const real = resolveSource(item.path!, (p) => allowedFolder(config, p));
      if (!real || overlaps(real, plan.destination)) {
        return fail('source_missing', `${item.path}: missing or not allowed`);
      }
      sources = [real];
    }
    if (sources.length === 0) return fail('source_missing', 'nothing to back up');

    // A `stop` app: stopped while it's copied, and always started again.
    let wasRunning = false;
    if (project) {
      const ps = await docker(config, ['compose', '-p', project, 'ps', '-q'], { capture: true });
      wasRunning = ps.code === 0 && ps.stdout.trim().length > 0;
      if (wasRunning) {
        phase('stopping');
        const stop = await docker(config, ['compose', '-p', project, 'stop'], { onLine: keep });
        if (stop.code !== 0) {
          await startAgain(config, paths, project, phase, keep, result);
          return fail('service_not_stopped', 'the app could not be stopped');
        }
      }
    }
    try {
      phase('archiving');
      const name = `${item.id}-${stamp()}`;
      const create = await borg(
        config,
        paths,
        'create',
        ['--json', '--compression', 'zstd,3', ...excludes, `${repo.path}::${name}`, ...sources],
        { capture: true, onLine: keep },
      );
      if (create.code >= 2 || stopping) {
        return fail(stopping ? 'interrupted' : borgFailure(create.logs), 'borg create failed');
      }
      result.archive = name;
      result.warnings = create.logs
        .filter((l) => l.level === 'WARNING')
        .map((l) => l.message.slice(0, 500))
        .slice(0, MAX_WARNINGS);
      result.status = create.code === 1 || result.warnings.length > 0 ? 'warning' : 'ok';
      try {
        const stats = (
          JSON.parse(create.stdout) as { archive?: { stats?: Record<string, number> } }
        ).archive?.stats;
        result.originalBytes = stats?.['original_size'] ?? null;
        result.addedBytes = stats?.['deduplicated_size'] ?? null;
      } catch {
        // no statistics: the archive is there all the same
      }
    } finally {
      if (dumpDir) rmSync(dumpDir, { recursive: true, force: true });
      if (project && wasRunning) await startAgain(config, paths, project, phase, keep, result);
    }
    // Started again or not (`startAgain` may have failed the item).
    if (result.errorCode === 'service_not_restarted') return result;

    phase('pruning');
    const keepArgs = [
      '--keep-daily',
      String(plan.retention.daily),
      '--keep-weekly',
      String(plan.retention.weekly),
      '--keep-monthly',
      String(plan.retention.monthly),
      ...(plan.schedule.frequency === 'every6h' ? ['--keep-hourly', '4'] : []),
    ];
    // The item id is a checked uuid: the glob matches its archives and nothing else.
    const glob = `${item.id}-*`;
    const prune = await borg(
      config,
      paths,
      'prune',
      ['--glob-archives', glob, ...keepArgs, repo.path],
      {
        onLine: keep,
      },
    );
    if (prune.code >= 2) keep('borg prune failed');
    result.archives = await listArchives(config, paths, repo, item.id);
    return result;
  } catch (error) {
    if (error instanceof Refusal) return fail(error.code, error.message);
    return fail('borg_failed', String((error as Error)?.message ?? error));
  }
}

/** Starts a stopped app again — retried; a failure is the most serious result there is. */
export async function startAgain(
  config: Config,
  paths: Paths,
  project: string,
  phase: (phase: string) => void,
  keep: (line: string) => void,
  result: ItemResult,
): Promise<void> {
  phase('starting');
  for (let attempt = 1; attempt <= RESTART_ATTEMPTS; attempt++) {
    const start = await docker(config, ['compose', '-p', project, 'start'], { onLine: keep });
    if (start.code === 0) return;
    if (attempt < RESTART_ATTEMPTS) await sleep(paths.retryDelayMs);
  }
  result.status = 'failed';
  result.errorCode = 'service_not_restarted';
  keep(`${project} could not be started again`);
}

export async function listArchives(
  config: Config,
  paths: Paths,
  repo: Repository,
  itemId: string,
): Promise<string[] | null> {
  const list = await borg(
    config,
    paths,
    'list',
    ['--json', '--glob-archives', `${itemId}-*`, repo.path],
    {
      capture: true,
    },
  );
  if (list.code !== 0) return null;
  try {
    const archives =
      (JSON.parse(list.stdout) as { archives?: { name?: unknown }[] }).archives ?? [];
    return archives
      .map((a) => String(a.name))
      .filter((name) => ARCHIVE_PATTERN.test(name) && name.startsWith(`${itemId}-`));
  } catch {
    return null;
  }
}
