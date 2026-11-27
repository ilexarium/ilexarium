// backup/recover-accounts.mts — runs as root.
//
// Whose files each app and folder holds: the accounts the new machine needs (restores keep owners
// by number). Information only: the person makes the accounts.

import { spawn } from 'node:child_process';
import { borgFailed } from './programs.mts';
import type { Config, Plan } from './model.mts';
import { outermost } from './places.mts';
import { ARCHIVE_PATTERN } from './plan.mts';
import { borgWith } from './recover-borg.mts';
import type { RecoveredAccount } from './recover-model.mts';
import { archiveFolders } from './restore.mts';
import { readLines } from '../lib/lines.mts';

/** An account name the backups may list: a Linux one, offered in a `useradd` command. */
export const ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_.-]*\$?$/;
export const ACCOUNT_NAME_MAX = 32;

/** Lines of `borg list` read for a folder's owner before giving up (its parents come first). */
export const OWNER_LINES_MAX = 64;

/**
 * The owner of each item's top folders in its newest backup. The first matching line of
 * `borg list` for each, never a full listing. Not fatal: null when Borg can't tell.
 */
export async function accountsOf(
  config: Config,
  env: Record<string, string>,
  repository: string,
  plan: Plan,
): Promise<RecoveredAccount[] | null> {
  try {
    const listed = await borgWith(config, env, 'list', ['--json', repository], { capture: true });
    if (borgFailed(listed)) return null;
    const names = (
      (JSON.parse(listed.stdout) as { archives?: { name?: unknown }[] }).archives ?? []
    )
      .map((a) => String(a.name))
      .filter((name) => ARCHIVE_PATTERN.test(name));
    const byUid = new Map<number, RecoveredAccount>();
    for (const item of plan.items) {
      if (item.kind === 'platform' || item.removed) continue;
      const newest = names
        .filter((name) => name.startsWith(`${item.id}-`))
        .sort()
        .at(-1);
      if (!newest) continue;
      const info = await borgWith(config, env, 'info', ['--json', `${repository}::${newest}`], {
        capture: true,
      });
      const folders = info.code === 0 ? outermost(archiveFolders(info.stdout) ?? []) : [];
      const label = item.kind === 'app' ? item.project! : item.path!;
      for (const folder of folders) {
        const owner = await ownerOf(config, env, `${repository}::${newest}`, folder);
        if (!owner) continue;
        const account = byUid.get(owner.uid) ?? { uid: owner.uid, name: owner.name, items: [] };
        if (!account.items.includes(label)) account.items.push(label);
        byUid.set(owner.uid, account);
      }
    }
    return [...byUid.values()].sort((a, b) => a.uid - b.uid);
  } catch {
    return null;
  }
}

/** A folder's owner in an archive: the line of `borg list` for it, the listing stopped there. */
function ownerOf(
  config: Config,
  env: Record<string, string>,
  archive: string,
  folder: string,
): Promise<{ uid: number; name: string } | null> {
  const relative = folder.slice(1);
  return new Promise((resolve) => {
    const child = spawn(
      config.backup.borgBin,
      ['list', '--format', '{type} {uid} {user} {path}{NL}', archive, relative],
      { env, cwd: '/', stdio: ['ignore', 'pipe', 'ignore'], shell: false },
    );
    let found: { uid: number; name: string } | null = null;
    let lines = 0;
    readLines(child.stdout, 64 * 1024, (line) => {
      if (found || ++lines > OWNER_LINES_MAX) {
        child.kill('SIGTERM');
        return;
      }
      const match = /^d (\d+) (\S*) (.*)$/.exec(line);
      if (match && match[3] === relative) {
        // A name that isn't a Linux one is left out: it would end up in a useradd command.
        const name =
          match[2].length <= ACCOUNT_NAME_MAX && ACCOUNT_NAME_PATTERN.test(match[2])
            ? match[2]
            : '';
        found = { uid: Number(match[1]), name };
        child.kill('SIGTERM');
      }
    });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(found));
  });
}
