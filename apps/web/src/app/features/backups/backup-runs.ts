import type { BackupRun } from '@ilex/shared';

/** What a run added to the disk, summed over its items; null when none says. */
export function runAdded(run: BackupRun): number | null {
  const sizes = run.items.map((i) => i.addedBytes).filter((b): b is number => b !== null);
  return sizes.length > 0 ? sizes.reduce((sum, b) => sum + b, 0) : null;
}

/** The items a run backed up (with or without warnings). */
export function runDone(run: BackupRun): number {
  return run.items.filter((i) => i.status !== 'failed').length;
}
