// Restores and `discard`. `restore-start` checks the request, keeps it in a root-only file and has
// systemd run `restore-run <id>` as its own unit (ilex-restore@<id>.service), so a restore goes
// on if the app stops. Its phases, output and result go to its job file (<state>/jobs/<id>.jsonl),
// which the app reads.
//
// Back where it was (no target): the item's folders in the plan now that the archive holds (the
// list its backup wrote in its comment) — each set aside as `<folder>.before-restore-<date>` first
// (the way back); a running app is stopped first and started again after (the app then offers to
// apply the restored settings, as the person). To a target folder (missing or empty): everything,
// with its full paths below it.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { absolute } from './config.mts';
import { openRepository } from './destination.mts';
import { folderStamp, JobFile, prepareState, writeAtomic } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, ItemResult, Paths, SetAside } from './model.mts';
import { allowedFolder, assertParentsSafe, below, outermost, overlaps } from './places.mts';
import { ARCHIVE_PATTERN, UUID, loadPlan } from './plan.mts';
import { borg, borgFailure, docker, takeLock } from './programs.mts';
import { startAgain } from './run.mts';
import { startDetached, startUnit } from './start.mts';
import { Refusal, emit, oneLine } from '../lib/output.mts';

export const SET_ASIDE_PATTERN = /\.before-restore-\d{8}-\d{6}$/;

export function readSetAside(paths: Paths): SetAside[] {
  const file = join(paths.state, 'set-aside.json');
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8')) as SetAside[];
  return Array.isArray(list) ? list.filter((e) => absolute(e.path) && UUID.test(e.restoreId)) : [];
}

export function writeSetAside(paths: Paths, list: SetAside[]): void {
  writeAtomic(join(paths.state, 'set-aside.json'), `${JSON.stringify(list, null, 2)}\n`, 0o600);
}

interface RestoreRequest {
  restoreId: string;
  itemId: string;
  archive: string;
  target: string | null;
}

const requestFile = (paths: Paths, id: string) =>
  join(paths.state, 'restore-requests', `${id}.json`);

/** A request, from the app (`restore-start`) or the root-only file (`restore-run`): checked the same. */
function checkRequest(
  config: Config,
  paths: Paths,
  given: Record<string, unknown>,
): RestoreRequest {
  const { restoreId, itemId, archive, target } = given;
  if (typeof restoreId !== 'string' || !UUID.test(restoreId)) {
    throw new Refusal('invalid_request', 'restoreId');
  }
  if (typeof itemId !== 'string' || !UUID.test(itemId))
    throw new Refusal('invalid_request', 'itemId');
  if (typeof archive !== 'string' || ARCHIVE_PATTERN.exec(archive)?.[1] !== itemId) {
    throw new Refusal('invalid_request', 'not an archive of this item');
  }
  if (target !== null && (!absolute(target) || !allowedFolder(config, target))) {
    throw new Refusal('path_not_allowed', 'target');
  }
  const plan = loadPlan(config, paths);
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new Refusal('item_not_found', 'no such item in the plan');
  if (target === null && item.kind === 'platform') {
    // The platform's files are the system's own: restored by hand (system/backup-recovery.md).
    throw new Refusal('invalid_request', 'the platform is restored to a folder');
  }
  if (target !== null && overlaps(target, plan.destination)) {
    throw new Refusal('path_not_allowed', 'target on the backup disk');
  }
  return { restoreId, itemId, archive, target: target as string | null };
}

/** `restore-start`: checks it, keeps it, has systemd run it; returns at once. */
export async function restoreStart(config: Config, paths: Paths, input: string): Promise<void> {
  const request = checkRequest(
    config,
    paths,
    parseInput(input, ['restoreId', 'itemId', 'archive', 'target']),
  );
  prepareState(config, paths);
  mkdirSync(dirname(requestFile(paths, request.restoreId)), { recursive: true, mode: 0o700 });
  if (existsSync(requestFile(paths, request.restoreId)))
    throw new Refusal('busy', 'started already', 3);
  writeAtomic(requestFile(paths, request.restoreId), `${JSON.stringify(request)}\n`, 0o600);
  if (await startUnit(config, `ilex-restore@${request.restoreId}.service`)) return;
  startDetached(
    config,
    paths,
    ['restore-run', request.restoreId],
    `restore-${request.restoreId}.log`,
  );
}

/** `restore-run <id>` (ilex-restore@<id>.service): the restore itself. */
export async function restoreRun(config: Config, paths: Paths, restoreId: string): Promise<number> {
  if (!UUID.test(restoreId)) throw new Refusal('invalid_request', 'not a restore id');
  prepareState(config, paths);
  const events = new JobFile(config, paths, restoreId);
  events.event({
    type: 'restore',
    restoreId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const phase = (name: string) => {
    emit(`@@phase ${name}`);
    events.event({ type: 'phase', phase: name });
  };
  const line = (text: string) => events.event({ type: 'line', text: text.slice(0, 2000) });
  const done = (
    status: 'succeeded' | 'failed',
    errorCode: string | null,
    setAside: string[],
    appWasRunning = false,
  ) => events.event({ type: 'restoreDone', status, errorCode, setAside, appWasRunning });
  // The folders set aside, in the job file before each is moved and after each goes back: a
  // restore killed before its end (kill -9, power loss) still tells the app where the previous
  // version is — at worst a folder too many, never one too few. Every end reports the same list.
  let setAside: string[] = [];
  const aside = (folders: string[]) => {
    setAside = folders;
    events.syncedEvent({ type: 'setAside', setAside });
  };
  let release: (() => void) | null = null;
  try {
    const file = requestFile(paths, restoreId);
    if (!existsSync(file)) throw new Refusal('not_found', 'no such restore request');
    const request = checkRequest(
      config,
      paths,
      JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>,
    );
    if (request.restoreId !== restoreId) throw new Refusal('invalid_request', 'another restore');
    // A backup run may hold the lock: a restore waits for it, like a scheduled run would.
    release = await takeLock(paths, true);
    const appWasRunning = await restoreArchive(config, paths, request, phase, line, aside);
    phase('done');
    done('succeeded', null, setAside, appWasRunning);
    rmSync(file, { force: true });
    return 0;
  } catch (error) {
    const refusal = error instanceof Refusal ? error : new Refusal('borg_failed', String(error), 5);
    line(oneLine(refusal.message));
    done('failed', refusal.code, setAside);
    rmSync(requestFile(paths, restoreId), { force: true });
    emit(`@@error code=${refusal.code}`);
    return refusal.exitCode;
  } finally {
    release?.();
  }
}

async function restoreArchive(
  config: Config,
  paths: Paths,
  request: RestoreRequest,
  phase: (name: string) => void,
  line: (text: string) => void,
  aside: (folders: string[]) => void,
): Promise<boolean> {
  const plan = loadPlan(config, paths);
  const item = plan.items.find((i) => i.id === request.itemId)!;
  const repo = openRepository(config, paths, plan);
  const info = await borg(config, paths, 'info', ['--json', `${repo.path}::${request.archive}`], {
    capture: true,
  });
  if (info.code !== 0) {
    throw new Refusal(borgFailure(info.logs, 'archive_not_found'), 'no such archive', 5);
  }

  if (request.target !== null) {
    phase('restoring');
    const target = request.target;
    assertParentsSafe(target);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(target).length > 0) {
        throw new Refusal('target_not_empty', 'the folder has something in it', 2);
      }
    }
    // Folders made here (the target, and the ones Borg makes above the restored data) passable
    // by everyone (0755), so each person can reach their own files; the restored files and
    // folders keep their own owners and modes (Borg sets them from the archive).
    process.umask(0o022);
    try {
      mkdirSync(target, { recursive: false, mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      const extract = await borg(
        config,
        paths,
        'extract',
        ['--numeric-ids', '--umask', '0022', `${repo.path}::${request.archive}`],
        { cwd: target, onLine: line },
      );
      if (extract.code >= 2) throw new Refusal(borgFailure(extract.logs), 'borg extract failed', 5);
    } finally {
      process.umask(0o077);
    }
    return false;
  }

  // Back where it was: what the archive holds of the item's folders in the plan now.
  const held = archiveFolders(info.stdout);
  if (!held) throw new Refusal('archive_not_found', 'the backup doesn’t list its folders', 5);
  const planned = item.kind === 'app' ? (item.folders ?? []) : [item.path!];
  // The archive lists them as they really were (any symlink above resolved).
  const same = (held: string, folder: string) =>
    held === folder || (existsSync(folder) && realpathSync(folder) === held);
  for (const folder of planned) {
    if (held.some((p) => same(p, folder))) continue;
    // Inside as it really is: a symlink above it can put it in, or out of, another folder.
    const real = existsSync(folder) ? realpathSync(folder) : folder;
    const outer = planned.find((f) => held.some((p) => same(p, f) && below(real, p)));
    line(
      outer
        ? `${folder}: inside ${outer}, restored with it`
        : `${folder}: not in this backup, left as it is`,
    );
  }
  const sources = held.filter((p) => planned.some((folder) => same(p, folder)));
  if (!sources.every((p) => allowedFolder(config, p))) {
    throw new Refusal('path_not_allowed', 'a folder that may not be restored', 5);
  }
  if (sources.length === 0) {
    throw new Refusal('archive_not_found', 'none of its folders is in the plan any more', 5);
  }
  for (const source of sources) assertParentsSafe(source);
  const project = item.kind === 'app' ? item.project! : null;
  let wasRunning = false;
  if (project) {
    const ps = await docker(config, ['compose', '-p', project, 'ps', '-q'], { capture: true });
    wasRunning = ps.code === 0 && ps.stdout.trim().length > 0;
  }
  // A folder inside another one (or one listed twice) is set aside and restored with the one that
  // holds it: on its own it would seem missing once that one is aside, and a failure would remove
  // it as made by the restore after the original came back.
  const restored = outermost(sources);
  const moved: { from: string; to: string }[] = [];
  /** What the job file was told is set aside (the one being moved included). */
  let told: string[] = [];
  /** Sources that weren't there before: on a failure, what was extracted of them goes. */
  const created: string[] = [];
  const result: ItemResult = {
    itemId: item.id,
    status: 'ok',
    errorCode: null,
    archive: request.archive,
    originalBytes: null,
    addedBytes: null,
    warnings: [],
    archives: null,
  };
  let failure: Refusal | null = null;
  try {
    if (wasRunning) {
      phase('stopping');
      const stop = await docker(config, ['compose', '-p', project!, 'stop'], { onLine: line });
      if (stop.code !== 0)
        throw new Refusal('service_not_stopped', 'the app could not be stopped', 5);
    }
    phase('restoring');
    const suffix = `.before-restore-${folderStamp()}`;
    const list = readSetAside(paths);
    for (const source of restored) {
      if (!existsSync(source)) {
        created.push(source);
        continue;
      }
      const to = `${source}${suffix}`;
      if (existsSync(to)) throw new Refusal('busy', 'try again in a second', 3);
      // Recorded before it happens: `discard` deletes only what's on this list.
      list.push({ path: to, restoreId: request.restoreId });
      writeSetAside(paths, list);
      told = [...moved.map((m) => m.to), to];
      aside(told);
      renameSync(source, to);
      moved.push({ from: source, to });
    }
    const extract = await borg(
      config,
      paths,
      'extract',
      ['--numeric-ids', `${repo.path}::${request.archive}`, ...restored.map((s) => s.slice(1))],
      { cwd: '/', onLine: line },
    );
    if (extract.code >= 2) throw new Refusal(borgFailure(extract.logs), 'borg extract failed', 5);
  } catch (error) {
    failure = error instanceof Refusal ? error : new Refusal('borg_failed', String(error), 5);
    // The way back: what was extracted of folders that weren't there goes first, while every
    // original is still aside — nothing removed here can be one; then each partly restored folder
    // goes and its set-aside one returns. Telling the job file is best effort here: the folders
    // going back comes first.
    for (const path of created) rmSync(path, { recursive: true, force: true });
    let last = told;
    const tell = (folders: string[]) => {
      last = folders;
      try {
        aside(folders);
      } catch {
        // The list a restore killed now would report is too long, never too short.
      }
    };
    while (moved.length > 0) {
      const { from, to } = moved.pop()!;
      rmSync(from, { recursive: true, force: true });
      renameSync(to, from);
      tell(moved.map((m) => m.to));
    }
    if (last.length > 0) tell([]);
    writeSetAside(
      paths,
      readSetAside(paths).filter((e) => !told.includes(e.path)),
    );
  } finally {
    if (wasRunning) {
      phase('starting');
      await startAgain(config, paths, project!, () => undefined, line, result);
    }
  }
  if (failure) throw failure;
  // The restore itself is done: the folders set aside are still reported.
  if (result.errorCode)
    throw new Refusal(result.errorCode, 'the app could not be started again', 5);
  return wasRunning;
}

/** The folders an archive holds, from the comment its backup wrote; null without one. */
export function archiveFolders(infoJson: string): string[] | null {
  try {
    const info = JSON.parse(infoJson) as { archives?: { comment?: unknown }[] };
    const comment = info.archives?.[0]?.comment;
    const folders: unknown = typeof comment === 'string' && comment ? JSON.parse(comment) : null;
    return Array.isArray(folders) && folders.every((f) => typeof f === 'string') ? folders : null;
  } catch {
    return null;
  }
}

export async function discard(config: Config, paths: Paths, input: string): Promise<void> {
  const { path } = parseInput(input, ['path']);
  if (!absolute(path) || !SET_ASIDE_PATTERN.test(path)) {
    throw new Refusal('invalid_request', 'path');
  }
  const release = await takeLock(paths, false);
  try {
    const list = readSetAside(paths);
    // Only a folder a restore set aside (its own list, root-only) — never any other path.
    if (!list.some((e) => e.path === path))
      throw new Refusal('not_found', 'not a set-aside folder');
    if (!allowedFolder(config, path)) throw new Refusal('path_not_allowed', 'not allowed');
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Refusal('path_not_allowed', 'not a folder');
      }
      assertParentsSafe(path);
      // Removes links inside as links, never what they point to.
      rmSync(path, { recursive: true, force: true });
    }
    writeSetAside(
      paths,
      list.filter((e) => e.path !== path),
    );
    emit('@@phase done');
  } finally {
    release();
  }
}
