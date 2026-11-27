// backup/run.mts — runs as root.
//
// `run-requested` and `run-scheduled`: back up every item of the plan (or one), each into its own
// archive.

import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openRepository } from './destination.mts';
import { JobFile, prepareState, stamp } from './files.mts';
import { FREE_SPACE_KEPT } from './init.mts';
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
import { allowedFolder, outermost, overlaps, resolveSource } from './places.mts';
import { ARCHIVE_PATTERN, loadPlan } from './plan.mts';
import {
  borg,
  borgFailed,
  borgFailure,
  docker,
  failedLine,
  sleep,
  stopping,
  takeLock,
} from './programs.mts';
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
  const start = (job: JobFile, items: string[]) =>
    job.event({
      type: 'run',
      runId,
      trigger,
      itemId: onlyItem,
      pid: process.pid,
      startedAt,
      items,
    });
  // A run refused before it starts is recorded all the same: nobody waits on this program's
  // output (a timer or "Back up now" started it), so the app learns it only from its job file.
  const refused = (error: unknown): unknown => {
    if (!(error instanceof Refusal)) return error;
    prepareState(config, paths);
    const job = new JobFile(config, paths, runId);
    start(job, []);
    job.event({
      type: 'runDone',
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
  let job: JobFile | null = null;
  try {
    prepareState(config, paths);
    job = new JobFile(config, paths, runId);
    start(
      job,
      items.map((item) => item.id),
    );
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
      let freed = false;
      for (const item of items) {
        if (stopping) break;
        const keep = (line: string) => {
          // Cut as the app reads it: one line too long would make it drop the whole result.
          output.push(line.slice(0, 2000));
          if (output.length > RESULT_OUTPUT_LINES) output.shift();
          job!.event({ type: 'line', itemId: item.id, text: line.slice(0, 2000) });
        };
        const phase = (name: string) => job!.event({ type: 'item', itemId: item.id, phase: name });
        let result = await backupItem(config, paths, plan, repo, item, phase, keep);
        // A full disk: old backups thinned with the retention as it is now, then once more.
        if (result.errorCode === 'disk_full' && !freed && !stopping) {
          freed = true;
          phase('pruning');
          if (await freeSpace(config, paths, plan, repo, keep)) {
            result = await backupItem(config, paths, plan, repo, item, phase, keep);
          }
        }
        results.push(result);
        job.event({ type: 'itemDone', result: { ...result, archives: undefined } });
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
    job?.event({
      type: 'runDone',
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
    const notApplied: string[] = [];
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
        const skipped = skipExcludes(item.skip, path, real);
        excludes.push(...skipped.excludes);
        notApplied.push(...skipped.notApplied);
      }
      // A `stop` app, by its project name: Compose finds its containers by their labels.
      if (item.mode === 'stop') project = item.project!;
    } else {
      const real = resolveSource(item.path!, (p) => allowedFolder(config, p));
      if (!real || overlaps(real, plan.destination)) {
        return fail('source_missing', `${item.path}: missing or not allowed`);
      }
      sources = [real];
      const skipped = skipExcludes(item.skip, item.path!, real);
      excludes.push(...skipped.excludes);
      notApplied.push(...skipped.notApplied);
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
        [
          '--json',
          '--compression',
          'zstd,3',
          // The folders it holds, read back by a restore in place.
          '--comment',
          JSON.stringify(sources),
          ...excludes,
          `${repo.path}::${name}`,
          // A folder inside another one only once, with it: given both, Borg stores it a second
          // time, its hard links then as links to themselves, which no extraction can restore.
          ...outermost(sources),
        ],
        { capture: true, onLine: keep },
      );
      if (borgFailed(create) || stopping) {
        return fail(
          stopping ? 'interrupted' : borgFailure(create),
          failedLine('borg create', create),
        );
      }
      result.archive = name;
      result.warnings = [
        ...notApplied.map(
          (skip) => `${skip}: not skipped, its folder's name has [, * or ? (backed up whole)`,
        ),
        ...create.logs.filter((l) => l.level === 'WARNING').map((l) => l.message.slice(0, 500)),
      ].slice(0, MAX_WARNINGS);
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
    await prune(config, paths, plan, repo, item.id, keep);
    result.archives = await listArchives(config, paths, repo, item.id);
    return result;
  } catch (error) {
    if (error instanceof Refusal) return fail(error.code, error.message);
    return fail('borg_failed', String((error as Error)?.message ?? error));
  }
}

/** `[`, `*` or `?` in a path: in a pattern they'd be read as more of the pattern. */
const PATTERN_CHARACTERS = /[[*?]/;

/**
 * Borg's `--exclude`s for the skips below `folder`, as it really is (`real`: a symlink above it
 * resolved). A skip below another of the item's folders is left for that one. A skip with `*` or
 * `?` becomes a pattern, the folder's path part of it: when that path has pattern characters too
 * (a symlink, or a plan from before the app refused it) the skip isn't applied — said in
 * `notApplied`, and the folder is backed up whole rather than not at all.
 */
export function skipExcludes(
  skips: string[] | undefined,
  folder: string,
  real: string,
): { excludes: string[]; notApplied: string[] } {
  const excludes: string[] = [];
  const notApplied: string[] = [];
  for (const skip of skips ?? []) {
    if (!skip.startsWith(`${folder}/`)) continue;
    const below = skip.slice(folder.length);
    if (!/[*?]/.test(below)) excludes.push('--exclude', `pp:${real}${below}`);
    else if (PATTERN_CHARACTERS.test(real)) notApplied.push(skip);
    else excludes.push('--exclude', `sh:${real}${below}`);
  }
  return { excludes, notApplied };
}

/** Thins an item's archives to the plan's retention. */
async function prune(
  config: Config,
  paths: Paths,
  plan: Plan,
  repo: Repository,
  itemId: string,
  keep: (line: string) => void,
): Promise<boolean> {
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
  const pruned = await borg(
    config,
    paths,
    'prune',
    ['--glob-archives', `${itemId}-*`, ...keepArgs, repo.path],
    { onLine: keep },
  );
  if (borgFailed(pruned)) keep(failedLine('borg prune', pruned));
  return !borgFailed(pruned);
}

/**
 * A full disk: every item still backed up thinned to the retention as it is now (lowered by the
 * owner, say), then compacted — which is what frees the space. Borg keeps free space for its own
 * commits (`FREE_SPACE_KEPT`), prunes included, so that's let go meanwhile and kept again after.
 * True when the compact went through (then a backup is worth trying again).
 */
export async function freeSpace(
  config: Config,
  paths: Paths,
  plan: Plan,
  repo: Repository,
  keep: (line: string) => void,
): Promise<boolean> {
  keep('The backup disk is full: thinning the old backups to the kept number, then trying again.');
  const reserve = (size: string) =>
    borg(config, paths, 'config', [repo.path, 'additional_free_space', size], { onLine: keep });
  // The repository's own value is kept again after (an older repository's may be none).
  const before = await borg(config, paths, 'config', [repo.path, 'additional_free_space'], {
    capture: true,
  });
  const kept =
    before.code === 0 && /^\d+[KMGT]?$/.test(before.stdout.trim())
      ? before.stdout.trim()
      : FREE_SPACE_KEPT;
  await reserve('0');
  try {
    for (const item of plan.items) {
      if (item.removed || stopping) continue;
      await prune(config, paths, plan, repo, item.id, keep);
    }
    if (stopping) return false;
    const compact = await borg(config, paths, 'compact', [repo.path], { onLine: keep });
    if (borgFailed(compact)) keep(failedLine('borg compact', compact));
    return !borgFailed(compact);
  } finally {
    const restored = await reserve(kept);
    if (restored.code !== 0) keep('borg config failed: no free space kept on the disk');
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
  const args = ['compose', '-p', project, 'start'];
  for (let attempt = 1; attempt <= RESTART_ATTEMPTS; attempt++) {
    const start = await docker(config, args, { onLine: keep });
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
