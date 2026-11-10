// `run <updateId>` (ilex-update@.service): the update itself, holding the root programs' lock.
// Everything it fetches is checked against this machine's installed key before it's used; the
// install goes back to the kept version if the new one doesn't come up.

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSmall, fetchToFile } from './download.mts';
import { answersAs, runInstaller, type Progress } from './install.mts';
import { JobFile } from './job.mts';
import type { Config, Manifest, Outcome, Paths, Programs } from './model.mts';
import { runProgram } from './programs.mts';
import {
  ARCHIVE_MAX_BYTES,
  installedVersion,
  MANIFEST_MAX_BYTES,
  newer,
  parseManifest,
  readSource,
  VERSION,
} from './release.mts';
import { rollBack } from './rollback.mts';
import { requestFile, UPDATE_ID } from './start.mts';
import { verifySignature } from '../lib/minisign.mts';
import { tryLock } from '../lib/lock.mts';
import { emit, Refusal } from '../lib/output.mts';

const MANIFEST_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 30 * 60_000;
const HEALTH_TIMEOUT_MS = 60_000;
const PROGRESS_EVERY_BYTES = 4 * 1024 * 1024;

export async function run(
  config: Config,
  paths: Paths,
  programs: Programs,
  updateId: string,
): Promise<number> {
  if (!UPDATE_ID.test(updateId)) throw new Refusal('invalid_request', 'not an update id');
  const request = requestFile(paths, updateId);
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(request, 'utf8')) as { version?: unknown }).version;
  } catch {
    throw new Refusal('invalid_request', 'no such update');
  } finally {
    rmSync(request, { force: true });
  }
  if (typeof version !== 'string' || !VERSION.test(version))
    throw new Refusal('invalid_request', 'version');

  // A machine installed before the setting was written runs Debian's.
  const sshUnit = config.update.sshUnit ?? 'ssh.service';
  const job = new JobFile(config, paths, updateId, false);
  const work = join(paths.state, updateId);
  let from = '';
  let unlock: (() => void) | null = null;
  // Cleaned up and unlocked before the end is written: whoever reads it may start the next thing.
  const tidy = () => {
    rmSync(work, { recursive: true, force: true });
    unlock?.();
    unlock = null;
  };
  const finish = (outcome: Outcome, installed: string, error?: string) => {
    tidy();
    job.event({ type: 'done', outcome, version: installed, ...(error && { error }) });
    emit(`@@result ${JSON.stringify({ outcome, version: installed, error })}`);
    return outcome === 'updated' ? 0 : 5;
  };

  // Whatever goes wrong from here on, the job file gets its end.
  try {
    from = installedVersion(paths);
    unlock = tryLock(paths.lock);
  } catch (error) {
    emit(`@@info ${String((error as Error)?.message ?? error)}`);
    return finish('failed', from, 'setup');
  }
  if (!unlock) return finish('failed', from, 'busy');
  let progress: Progress = { phases: new Set(), dump: null };
  try {
    let unpacked: string;
    try {
      unpacked = await download(paths, programs, job, work, version, from);
    } catch (error) {
      if (error instanceof Refusal) {
        emit(`@@info ${error.message}`);
        return finish('failed', from, error.code);
      }
      throw error;
    }

    job.event({ type: 'phase', phase: 'install' });
    emit('@@phase install');
    const installed = await runInstaller(programs, unpacked, job);
    progress = installed.progress;
    if (installed.code === 0) {
      job.event({ type: 'phase', phase: 'health' });
      if (await answersAs(paths.healthUrl, version, HEALTH_TIMEOUT_MS))
        return finish('updated', version);
    }
    const error = installed.code === 0 ? 'not_answering' : 'install_failed';
    const back = await rollBack(paths, programs, job, progress, from, sshUnit);
    if (back === 'nothing_changed') return finish('failed', from, error);
    return finish(back, back === 'rolled_back' ? from : version, error);
  } catch (error) {
    // Whatever went wrong, the machine mustn't be left half-installed.
    emit(`@@info ${String((error as Error)?.message ?? error)}`);
    const back = await rollBack(paths, programs, job, progress, from, sshUnit);
    if (back === 'nothing_changed') return finish('failed', from, 'internal');
    return finish(back, back === 'rolled_back' ? from : version, 'internal');
  } finally {
    tidy();
  }
}

async function download(
  paths: Paths,
  programs: Programs,
  job: JobFile,
  work: string,
  version: string,
  from: string,
): Promise<string> {
  const source = readSource(paths);
  const base = `${source.url}/download/v${version}`;

  job.event({ type: 'phase', phase: 'check' });
  emit('@@phase check');
  const manifestBytes = await fetchSmall(
    `${base}/manifest.json`,
    MANIFEST_MAX_BYTES,
    MANIFEST_TIMEOUT_MS,
  );
  const signature = await fetchSmall(
    `${base}/manifest.json.minisig`,
    MANIFEST_MAX_BYTES,
    MANIFEST_TIMEOUT_MS,
  );
  if (!verifySignature(source.key, signature.toString('utf8'), manifestBytes)) {
    throw new Refusal('bad_signature', 'the manifest is not signed by the installed key', 5);
  }
  const manifest: Manifest | null = parseManifest(manifestBytes.toString('utf8'));
  if (!manifest) throw new Refusal('bad_manifest', 'the manifest is malformed', 5);
  if (manifest.version !== version)
    throw new Refusal('bad_manifest', `the manifest is for ${manifest.version}`, 5);
  if (!newer(version, from)) throw new Refusal('not_newer', `${from} is installed`, 5);

  job.event({ type: 'phase', phase: 'download', total: manifest.size });
  emit('@@phase download');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { mode: 0o700 });
  const archive = join(work, manifest.archive);
  let reported = 0;
  const got = await fetchToFile(
    `${base}/${manifest.archive}`,
    archive,
    Math.min(manifest.size, ARCHIVE_MAX_BYTES),
    ARCHIVE_TIMEOUT_MS,
    (bytes) => {
      if (bytes - reported >= PROGRESS_EVERY_BYTES) {
        reported = bytes;
        job.event({ type: 'progress', bytes, total: manifest.size });
      }
    },
  );
  if (got.size !== manifest.size)
    throw new Refusal('wrong_size', 'the download has the wrong size', 5);
  if (got.sha256 !== manifest.sha256)
    throw new Refusal('wrong_checksum', 'the download does not match its fingerprint', 5);

  job.event({ type: 'phase', phase: 'unpack' });
  emit('@@phase unpack');
  if ((await runProgram(programs.tar, ['-xzf', archive, '-C', work])) !== 0) {
    throw new Refusal('unpack_failed', 'the archive could not be unpacked', 5);
  }
  const unpacked = join(work, `ilex-${version}`);
  let shipped = '';
  try {
    shipped = readFileSync(join(unpacked, 'VERSION'), 'utf8').trim();
  } catch {
    // checked below
  }
  if (shipped !== version)
    throw new Refusal('bad_manifest', 'the archive holds another version', 5);
  return unpacked;
}
