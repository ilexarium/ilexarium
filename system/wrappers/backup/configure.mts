// backup/configure.mts — REVIEW-REQUIRED (system/CLAUDE.md): runs as root.
//
// `configure`: the plan for the timer, and the timer's schedule.

import { writeAtomic } from './files.mts';
import type { Config, Paths, Plan } from './model.mts';
import { checkPlan } from './plan.mts';
import { home, runProgram } from './programs.mts';
import { Refusal } from '../lib/output.mts';
import { SAFE_PATH } from '../lib/paths.mts';

// configure

export function onCalendar(schedule: Plan['schedule']): string {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const step = { daily: 24, every12h: 12, every6h: 6 }[schedule.frequency];
  const hours: number[] = [];
  for (let h = hour % step; h < 24; h += step) hours.push(h);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `*-*-* ${hours.map(pad).join(',')}:${pad(minute)}:00`;
}

export async function configure(config: Config, paths: Paths, input: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Refusal('invalid_plan', 'not JSON');
  }
  const plan = checkPlan(raw, config, paths);
  writeAtomic(paths.plan, `${JSON.stringify(plan, null, 2)}\n`, 0o600);
  writeAtomic(
    paths.timerDropIn,
    `# Written by laris-backup configure.\n[Timer]\nOnCalendar=\nOnCalendar=${onCalendar(plan.schedule)}\n`,
    0o644,
  );
  const systemctl = config.backup.systemctlBin;
  if (!systemctl) return;
  const env = { PATH: SAFE_PATH, HOME: home(config) };
  for (const args of [
    ['daemon-reload'],
    ['enable', '--now', 'laris-backup.timer', 'laris-backup-check.timer'],
  ]) {
    const result = await runProgram(systemctl, args, { env });
    if (result.code !== 0) throw new Refusal('setup', `systemctl ${args[0]} failed`, 6);
  }
}
