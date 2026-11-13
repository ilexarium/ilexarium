// The record of which parts of the suite passed at which commit: written by `npm run verify`,
// read by `npm run ship`, which releases only a commit at which every part passed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Git-ignored (.dev/), and never in a release archive. */
export const STAMP_FILE = fileURLToPath(new URL('../../.dev/verified.json', import.meta.url));

/** Every part, in the order verify runs them; ship needs them all. */
export const PARTS = ['lint', 'format', 'unit', 'e2e', 'install'];

/** The record in `file`, or an empty one when there's none (or it can't be read). */
export function readStamp(file) {
  try {
    const stamp = JSON.parse(readFileSync(file, 'utf8'));
    return stamp && typeof stamp === 'object' && !Array.isArray(stamp) ? stamp : {};
  } catch {
    return {};
  }
}

export function writeStamp(file, stamp) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`);
}

/** The record with `part` passed at `commit`; the other parts as they were. */
export function withPassed(stamp, part, commit, at) {
  return { ...stamp, [part]: { commit, at } };
}

/** The parts that haven't passed at `commit`, each with the commit it last passed at (or null). */
export function unverified(stamp, commit) {
  return PARTS.filter((part) => stamp[part]?.commit !== commit).map((part) => ({
    part,
    passedAt: typeof stamp[part]?.commit === 'string' ? stamp[part].commit : null,
  }));
}

/**
 * Why a run can't vouch for a commit, or undefined when it can: `before` and `after` are the
 * repository's commit and whether its tree was clean, when the run started and now.
 */
export function notRecordable(before, after) {
  if (!before.clean || !after.clean) return 'the working tree has changes that are not committed';
  if (before.commit !== after.commit) {
    return `the commit changed during the run (${before.commit} → ${after.commit})`;
  }
  return undefined;
}
