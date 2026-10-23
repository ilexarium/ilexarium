// backup/restore.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// `restore` and `discard`: putting an archive back, and deleting what a restore set aside.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { absolute } from './config.mts';
import { openRepository } from './destination.mts';
import { folderStamp, prepareState, writeAtomic } from './files.mts';
import { parseInput } from './input.mts';
import type { Config, ItemResult, Paths, SetAside } from './model.mts';
import {
  allowedFolder,
  allowedServiceFolder,
  assertParentsSafe,
  resolveSource,
} from './places.mts';
import { ARCHIVE_PATTERN, UUID, loadPlan } from './plan.mts';
import { borg, borgFailure, docker, takeLock } from './programs.mts';
import { startAgain } from './run.mts';
import { Refusal, emit } from '../lib/output.mts';
import { isPlainAbsolutePath } from '../lib/paths.mts';

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

export async function restore(config: Config, paths: Paths, input: string): Promise<void> {
  const given = parseInput(input, ['restoreId', 'itemId', 'archive', 'target']);
  const { restoreId, itemId, archive, target } = given;
  if (typeof restoreId !== 'string' || !UUID.test(restoreId)) {
    throw new Refusal('invalid_request', 'restoreId');
  }
  if (typeof itemId !== 'string' || !UUID.test(itemId))
    throw new Refusal('invalid_request', 'itemId');
  if (typeof archive !== 'string' || ARCHIVE_PATTERN.exec(archive)?.[1] !== itemId) {
    throw new Refusal('invalid_request', 'not an archive of this item');
  }
  if (target !== 'inPlace' && target !== 'newFolder')
    throw new Refusal('invalid_request', 'target');

  const plan = loadPlan(config, paths);
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new Refusal('item_not_found', 'no such item in the plan');
  // In place only for services (home folders are never written into as root; the platform is
  // restored by hand on a new machine).
  if (target === 'inPlace' && item.kind !== 'service') {
    throw new Refusal('invalid_request', 'only services are restored in place');
  }
  const release = await takeLock(paths, false);
  try {
    prepareState(config, paths);
    const repo = openRepository(config, paths, plan);

    // What the archive holds: the sources its own `borg create` named.
    const info = await borg(config, paths, 'info', ['--json', `${repo.path}::${archive}`], {
      capture: true,
    });
    if (info.code !== 0)
      throw new Refusal(borgFailure(info.logs, 'archive_not_found'), 'no such archive', 5);
    const sources = archiveSources(info.stdout, archive);
    const allowed =
      item.kind === 'platform'
        ? (p: string) =>
            p === join(paths.state, 'platform') || config.backup.platform.files.includes(p)
        : item.kind === 'service'
          ? (p: string) => allowedServiceFolder(config, p)
          : (p: string) => allowedFolder(config, p);
    if (sources.length === 0 || !sources.every((s) => isPlainAbsolutePath(s) && allowed(s))) {
      throw new Refusal('archive_not_found', 'the archive holds unexpected paths', 5);
    }

    if (target === 'newFolder') {
      emit('@@phase restoring');
      // Folders created here — the restore area, the new folder (this umask), and the ones Borg
      // makes above the restored data, e.g. …/home/alice/ (its own --umask: Borg ignores the
      // inherited one) — passable by everyone (0755), so each person can reach their own
      // restored files; with the usual 077 they'd be root-only. The restored files and folders
      // keep their own owners and modes (Borg sets them from the archive).
      process.umask(0o022);
      try {
        mkdirSync(paths.restores, { recursive: true, mode: 0o755 });
        const folder = join(paths.restores, `${itemId.slice(0, 8)}-${folderStamp()}`);
        if (existsSync(folder)) throw new Refusal('busy', 'try again in a second', 3);
        mkdirSync(folder, { mode: 0o755 });
        // Everything, with its full path below the new folder and its original owners.
        const extract = await borg(
          config,
          paths,
          'extract',
          ['--numeric-ids', '--umask', '0022', `${repo.path}::${archive}`],
          {
            cwd: folder,
          },
        );
        if (extract.code >= 2) {
          throw new Refusal(borgFailure(extract.logs), 'borg extract failed', 5);
        }
        emit(`@@result ${JSON.stringify({ targetPath: folder, setAside: [] })}`);
      } finally {
        process.umask(0o077);
      }
      emit('@@phase done');
      return;
    }

    // In place: only back into the service's current folders.
    const current = Object.values(item.folders ?? {}).map(
      (p) => resolveSource(p, (x) => allowedServiceFolder(config, x)) ?? p,
    );
    if (!sources.every((s) => current.includes(s))) {
      throw new Refusal(
        'paths_changed',
        'the service uses other folders now: restore to a new folder',
        2,
      );
    }
    for (const source of sources) assertParentsSafe(source, config.storageRoots);

    const project = `hl-${item.catalogId}`;
    const ps = await docker(config, ['compose', '-p', project, 'ps', '-q'], { capture: true });
    const wasRunning = ps.code === 0 && ps.stdout.trim().length > 0;
    const moved: { from: string; to: string }[] = [];
    /** Sources that weren't there before: on a failure, what was extracted of them goes. */
    const created: string[] = [];
    const result: ItemResult = {
      itemId,
      status: 'ok',
      errorCode: null,
      archive,
      originalBytes: null,
      addedBytes: null,
      warnings: [],
      archives: null,
    };
    let failure: Refusal | null = null;
    try {
      if (wasRunning) {
        emit('@@phase stopping');
        const stop = await docker(config, ['compose', '-p', project, 'stop']);
        if (stop.code !== 0) {
          throw new Refusal('service_not_stopped', 'the service could not be stopped', 5);
        }
      }
      emit('@@phase restoring');
      const suffix = `.before-restore-${folderStamp()}`;
      const list = readSetAside(paths);
      for (const source of sources) {
        if (!existsSync(source)) {
          created.push(source);
          continue;
        }
        const to = `${source}${suffix}`;
        if (existsSync(to)) throw new Refusal('busy', 'try again in a second', 3);
        // Recorded before it happens: `discard` deletes only what's on this list.
        list.push({ path: to, restoreId });
        writeSetAside(paths, list);
        renameSync(source, to);
        moved.push({ from: source, to });
      }
      const extract = await borg(
        config,
        paths,
        'extract',
        ['--numeric-ids', `${repo.path}::${archive}`, ...sources.map((s) => s.slice(1))],
        { cwd: '/' },
      );
      if (extract.code >= 2) throw new Refusal(borgFailure(extract.logs), 'borg extract failed', 5);
    } catch (error) {
      failure = error instanceof Refusal ? error : new Refusal('borg_failed', String(error), 5);
      // The way back: the partly restored folders go, the set-aside ones return.
      for (const { from, to } of moved.reverse()) {
        rmSync(from, { recursive: true, force: true });
        renameSync(to, from);
      }
      for (const path of created) rmSync(path, { recursive: true, force: true });
      writeSetAside(
        paths,
        readSetAside(paths).filter((e) => !moved.some((m) => m.to === e.path)),
      );
      moved.length = 0;
    } finally {
      if (wasRunning) {
        emit('@@phase starting');
        await startAgain(
          config,
          paths,
          project,
          () => undefined,
          (line) => emit(`> ${line}`),
          result,
        );
      }
    }
    if (failure) throw failure;
    // Restored: where the previous version went is reported even if the start then failed.
    emit(`@@result ${JSON.stringify({ targetPath: null, setAside: moved.map((m) => m.to) })}`);
    if (result.errorCode) {
      throw new Refusal(result.errorCode, 'the service could not be started again', 5);
    }
    emit('@@phase done');
  } finally {
    release();
  }
}

/** The source folders of an archive, from its recorded `borg create` command line. */
export function archiveSources(infoJson: string, archive: string): string[] {
  try {
    const info = JSON.parse(infoJson) as { archives?: { command_line?: unknown }[] };
    const line = info.archives?.[0]?.command_line;
    if (!Array.isArray(line)) return [];
    const at = line.findIndex((arg) => typeof arg === 'string' && arg.endsWith(`::${archive}`));
    if (at < 0) return [];
    return line.slice(at + 1).map(String);
  } catch {
    return [];
  }
}

export async function discard(config: Config, paths: Paths, input: string): Promise<void> {
  const { path } = parseInput(input, ['path']);
  if (!absolute(path) || !SET_ASIDE_PATTERN.test(path))
    throw new Refusal('invalid_request', 'path');
  const release = await takeLock(paths, false);
  try {
    const list = readSetAside(paths);
    // Only a folder a restore set aside (its own list, root-only) — never any other path.
    if (!list.some((e) => e.path === path))
      throw new Refusal('not_found', 'not a set-aside folder');
    if (!allowedServiceFolder(config, path)) throw new Refusal('path_not_allowed', 'not allowed');
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Refusal('path_not_allowed', 'not a folder');
      }
      assertParentsSafe(path, config.storageRoots);
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
