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
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  openSync,
  closeSync,
  fchownSync,
  fchmodSync,
  constants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { absolute } from './config.mts';
import { mounts, openRepository } from './destination.mts';
import { folderStamp, JobFile, prepareState, writeAtomic } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, ItemResult, Paths, SetAside } from './model.mts';
import {
  allowedFolder,
  askingAccount,
  assertParentsSafe,
  assertSafeFolder,
  below,
  outermost,
  overlaps,
} from './places.mts';
import { ARCHIVE_PATTERN, UUID, loadPlan } from './plan.mts';
import {
  borg,
  borgFailed,
  borgFailure,
  docker,
  failedLine,
  removeFolder,
  takeLock,
} from './programs.mts';
import { MAX_WARNINGS, startAgain } from './run.mts';
import { startDetached, startUnit } from './start.mts';
import { Refusal, emit, oneLine } from '../lib/output.mts';
import { isRoot } from '../lib/startup.mts';

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
  /** The uid of the person whose sudo started it (`askingAccount`), never from the app. */
  askedBy: number;
}

/**
 * A disk mounted at a folder, or inside it, is refused where a folder is moved or deleted: moving
 * it takes the disk along (its files then restored onto the disk above), and deleting what was set
 * aside would empty that disk.
 */
function mountAt(paths: Paths, folder: string): string | undefined {
  return [...mounts(paths.mountInfo).keys()].find((m) => m === folder || below(m, folder));
}

function assertNoMount(paths: Paths, folder: string): void {
  const mount = mountAt(paths, folder);
  if (mount === undefined) return;
  const where = mount === folder ? 'is a mount point' : `has a disk mounted inside (${mount})`;
  throw new Refusal('mount_inside', `${folder} ${where}`, 2);
}

/** A restore's warnings: Borg's (exit code 1), each line cut, at most `MAX_WARNINGS`. */
function extractWarnings(ran: { code: number | null; logs: { level: string; message: string }[] }) {
  const warnings = ran.logs
    .filter((l) => l.level === 'WARNING')
    .map((l) => l.message.slice(0, 500))
    .slice(0, MAX_WARNINGS);
  if (ran.code === 1 && warnings.length === 0) warnings.push('Borg finished with warnings');
  return warnings;
}

const requestFile = (paths: Paths, id: string) =>
  join(paths.state, 'restore-requests', `${id}.json`);

/**
 * A target: below folders nobody but root and the person who asked can change, and missing or an
 * empty folder that is just as safe.
 */
function checkTarget(target: string, askedBy: number): void {
  assertParentsSafe(target, askedBy);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(target).length > 0) {
    throw new Refusal('target_not_empty', 'the folder has something in it', 2);
  }
  assertSafeFolder(target, askedBy);
}

/**
 * A request, from the app (`restore-start`, who asked found by this program) or the root-only
 * file (`restore-run`): checked the same — where it writes too, so the person hears of a refusal
 * at once; `restoreArchive` checks that again right before anything is moved.
 */
function checkRequest(
  config: Config,
  paths: Paths,
  given: Record<string, unknown>,
  askedBy: unknown,
): RestoreRequest {
  const { restoreId, itemId, archive, target } = given;
  if (typeof askedBy !== 'number' || !Number.isInteger(askedBy) || askedBy < 0) {
    throw new Refusal('invalid_request', 'askedBy');
  }
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
  if (target !== null) checkTarget(target, askedBy);
  else {
    // Only what is moved aside: a folder inside another goes with it (`restoreArchive`).
    const folders = item.kind === 'app' ? (item.folders ?? []) : [item.path!];
    const real = folders.map((folder) => (existsSync(folder) ? realpathSync(folder) : folder));
    for (const folder of outermost(real)) {
      assertParentsSafe(folder, askedBy);
      assertNoMount(paths, folder);
    }
  }
  return { restoreId, itemId, archive, target: target as string | null, askedBy };
}

/** `restore-start`: checks it, keeps it, has systemd run it; returns at once. */
export async function restoreStart(config: Config, paths: Paths, input: string): Promise<void> {
  const request = checkRequest(
    config,
    paths,
    parseInput(input, ['restoreId', 'itemId', 'archive', 'target']),
    askingAccount(config),
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
    warnings: string[] = [],
  ) => events.event({ type: 'restoreDone', status, errorCode, setAside, appWasRunning, warnings });
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
    const given = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const request = checkRequest(config, paths, given, given['askedBy']);
    if (request.restoreId !== restoreId) throw new Refusal('invalid_request', 'another restore');
    // A backup run may hold the lock: a restore waits for it, like a scheduled run would.
    release = await takeLock(paths, true);
    const restored = await restoreArchive(config, paths, request, phase, line, aside);
    phase('done');
    done('succeeded', null, setAside, restored.appWasRunning, restored.warnings);
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
): Promise<{ appWasRunning: boolean; warnings: string[] }> {
  const plan = loadPlan(config, paths);
  const item = plan.items.find((i) => i.id === request.itemId)!;
  const repo = openRepository(config, paths, plan);
  const info = await borg(config, paths, 'info', ['--json', `${repo.path}::${request.archive}`], {
    capture: true,
  });
  if (info.code !== 0) {
    const why = info.signal ? failedLine('borg info', info) : 'no such archive';
    throw new Refusal(borgFailure(info, 'archive_not_found'), why, 5);
  }

  if (request.target !== null) {
    phase('restoring');
    const target = request.target;
    checkTarget(target, request.askedBy);
    // The folders Borg makes above the restored data are new (0755): a file private only because
    // of a home folder above it would be open to every account. So the target is private to the
    // person who asked (root's, when root asked) — they open it up when they want to; inside it,
    // the restored files and folders keep their own owners and modes (Borg sets them).
    process.umask(0o022);
    try {
      mkdirSync(target, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      // Made by someone else between the check and mkdir (which then found it): refused too.
      assertSafeFolder(target, request.askedBy);
      chmodSync(target, 0o700);
      const extract = await borg(
        config,
        paths,
        'extract',
        ['--numeric-ids', '--umask', '0022', `${repo.path}::${request.archive}`],
        { cwd: target, onLine: line },
      );
      if (borgFailed(extract)) {
        throw new Refusal(borgFailure(extract), failedLine('borg extract', extract), 5);
      }
      return { appWasRunning: false, warnings: extractWarnings(extract) };
    } finally {
      process.umask(0o077);
      // Theirs only now: nobody but root changes the folders Borg makes while it extracts.
      if (isRoot && lstatSync(target).uid === 0) chownSync(target, request.askedBy, -1);
    }
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
  // A folder inside another one (or one listed twice) is set aside and restored with the one that
  // holds it: on its own it would seem missing once that one is aside, and a failure would remove
  // it as made by the restore after the original came back. Only these are moved, so only their
  // parents are checked (an inner folder's parent is the outer one, often a container's uid).
  const restored = outermost(sources);
  for (const source of restored) {
    assertParentsSafe(source, request.askedBy);
    assertNoMount(paths, source);
  }
  const project = item.kind === 'app' ? item.project! : null;
  let wasRunning = false;
  if (project) {
    const ps = await docker(config, ['compose', '-p', project, 'ps', '-q'], { capture: true });
    wasRunning = ps.code === 0 && ps.stdout.trim().length > 0;
  }
  const moved: { from: string; to: string }[] = [];
  /** The folders the job file was told are set aside (the one being moved included). */
  let reportedAside: string[] = [];
  /** Sources that weren't there before: on a failure, what was extracted of them goes. */
  const created: string[] = [];
  /** The folders above them Borg makes (as root, 0700): each source's, outermost first. */
  const madeAbove = new Map<string, string[]>();
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
  const warnings: string[] = [];
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
        madeAbove.set(source, missingParents(source));
        continue;
      }
      const to = `${source}${suffix}`;
      if (existsSync(to)) throw new Refusal('busy', 'try again in a second', 3);
      // Recorded before it happens: `discard` deletes only what's on this list.
      list.push({ path: to, restoreId: request.restoreId });
      writeSetAside(paths, list);
      reportedAside = [...moved.map((m) => m.to), to];
      aside(reportedAside);
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
    if (borgFailed(extract)) {
      throw new Refusal(borgFailure(extract), failedLine('borg extract', extract), 5);
    }
    warnings.push(...extractWarnings(extract));
    giveParentsToOwner(madeAbove);
    // Listed in the archive's comment but not in its files (unreadable when it was backed up):
    // what was there goes back rather than the folder being gone.
    const missing = (path: string) => !lstatSync(path, { throwIfNoEntry: false });
    for (const source of created.filter(missing)) {
      warnings.push(`${source}: not in this backup's files`);
    }
    // A folder inside a moved one: its previous version is inside the one set aside.
    for (const source of sources.filter((p) => !restored.includes(p) && missing(p))) {
      const outer = moved.find((m) => below(source, m.from));
      warnings.push(
        outer
          ? `${source}: not in this backup's files, its previous version is in ${outer.to}`
          : `${source}: not in this backup's files`,
      );
    }
    const returned = moved.filter((m) => missing(m.from));
    if (returned.length > 0) {
      for (const { from, to } of returned) {
        renameSync(to, from);
        moved.splice(
          moved.findIndex((m) => m.to === to),
          1,
        );
        warnings.push(`${from}: not in this backup's files, the current folder was put back`);
      }
      const putBack = returned.map((m) => m.to);
      reportedAside = reportedAside.filter((path) => !putBack.includes(path));
      aside(reportedAside);
      writeSetAside(
        paths,
        readSetAside(paths).filter((e) => !putBack.includes(e.path)),
      );
    }
  } catch (error) {
    failure = error instanceof Refusal ? error : new Refusal('borg_failed', String(error), 5);
    // The way back: what was extracted of folders that weren't there goes first, while every
    // original is still aside — nothing removed here can be one; then each partly restored folder
    // goes and its set-aside one returns. Telling the job file is best effort here: the folders
    // going back comes first.
    // Never leaving their disk (`removeFolder`); a folder that can't go keeps the previous
    // version where it was set aside, still reported (and listed for `discard`).
    for (const path of created) {
      if (mountAt(paths, path) !== undefined || !(await removeFolder(config, path))) {
        line(`${path}: could not be removed`);
      }
    }
    removeEmptyParents(madeAbove);
    let last = reportedAside;
    const tell = (folders: string[]) => {
      last = folders;
      try {
        aside(folders);
      } catch {
        // The list a restore killed now would report is too long, never too short.
      }
    };
    const kept: string[] = [];
    while (moved.length > 0) {
      const { from, to } = moved.pop()!;
      // A bind mount of the same disk is one rm would walk into: mountinfo says so first.
      if (mountAt(paths, from) === undefined && (await removeFolder(config, from))) {
        renameSync(to, from);
      } else {
        kept.push(to);
        line(`${from}: could not be removed, the previous version stays at ${to}`);
      }
      tell([...moved.map((m) => m.to), ...kept]);
    }
    if (last.length !== kept.length) tell(kept);
    writeSetAside(
      paths,
      readSetAside(paths).filter((e) => !reportedAside.includes(e.path) || kept.includes(e.path)),
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
  return { appWasRunning: wasRunning, warnings: warnings.slice(0, MAX_WARNINGS) };
}

/** The folders above `path` that aren't there, outermost first. */
export function missingParents(path: string): string[] {
  const missing: string[] = [];
  for (let parent = dirname(path); !existsSync(parent); parent = dirname(parent)) {
    missing.unshift(parent);
  }
  return missing;
}

/**
 * Borg makes the folders above an extracted one as root, 0700 (`~/apps` on a new machine): each
 * is given the owner of the folder above them that was there (`/home/anna`'s: anna), 0755 — never
 * the restored folder's, which may be a container's uid. Through a handle opened without following
 * a symlink, deepest first: only root and the person who asked (a sudoer) may change the folders
 * above (`assertParentsSafe`), so nobody gains by swapping one meanwhile, but root still never
 * changes anything but the folder it made.
 */
export function giveParentsToOwner(madeAbove: Map<string, string[]>): void {
  for (const parents of madeAbove.values()) {
    if (parents.length === 0) continue;
    const owner = lstatSync(dirname(parents[0]), { throwIfNoEntry: false });
    if (!owner?.isDirectory()) continue;
    for (const parent of [...parents].reverse()) {
      let fd: number;
      try {
        fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch {
        continue; // gone (a failed restore removed it), or not a plain folder
      }
      try {
        if (isRoot) fchownSync(fd, owner.uid, owner.gid);
        fchmodSync(fd, 0o755);
      } finally {
        closeSync(fd);
      }
    }
  }
}

/** After a failure: the folders made above a source go again if empty; the others become their owner's. */
export function removeEmptyParents(madeAbove: Map<string, string[]>): void {
  for (const parents of madeAbove.values()) {
    for (const parent of [...parents].reverse()) {
      try {
        rmdirSync(parent);
      } catch {
        // Not empty (a folder that couldn't be removed is in it), or already gone.
      }
    }
  }
  giveParentsToOwner(madeAbove);
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
      assertParentsSafe(path, askingAccount(config));
      assertNoMount(paths, path);
      // Links inside go as links, never what they point to; a disk mounted meanwhile stays.
      if (!(await removeFolder(config, path))) {
        throw new Refusal('borg_failed', `${path} could not be removed`, 5);
      }
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
