// backup/check.mts — runs as root.
//
// `check`: the weekly repository check (the first one of a month also reads every chunk of
// data).

import { randomUUID } from 'node:crypto';
import { openRepository } from './destination.mts';
import { JobFile, prepareState } from './files.mts';
import type { Config, Paths, Plan } from './model.mts';
import { loadPlan } from './plan.mts';
import { borg, borgFailure, takeLock } from './programs.mts';
import { emit, oneLine, Refusal } from '../lib/output.mts';

export async function check(config: Config, paths: Paths): Promise<number> {
  const release = await takeLock(paths, true);
  let plan: Plan;
  try {
    plan = loadPlan(config, paths);
  } catch (error) {
    release();
    throw error;
  }
  const startedAt = new Date().toISOString();
  const full = new Date().getDate() <= 7;
  const checkId = randomUUID();
  let status = 'ok';
  let errorCode: string | null = null;
  try {
    prepareState(config, paths);
    const job = new JobFile(config, paths, checkId);
    job.event({ type: 'check', checkId, full, pid: process.pid, startedAt });
    try {
      const repo = openRepository(config, paths, plan);
      const result = await borg(config, paths, 'check', [
        ...(full ? ['--verify-data'] : []),
        repo.path,
      ]);
      if (result.code !== 0) {
        status = 'failed';
        errorCode = borgFailure(result, 'repository_damaged');
      }
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      status = 'failed';
      errorCode = error.code;
      emit(`@@info ${oneLine(error.message)}`);
    }
    job.event({
      type: 'checkDone',
      checkId,
      full,
      status,
      errorCode,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    release();
  }
  if (errorCode) emit(`@@error code=${errorCode}`);
  return status === 'ok' ? 0 : 5;
}
