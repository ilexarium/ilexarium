import { PROCESS_LIMITS, PROCESS_SIGNALS, type ProcessSignal } from '@laris/shared';
import type { LinuxCommand } from '../linux-sessions/linux-sessions.model.js';

/**
 * The one command line ending a process (docs/plans/process_list.md, a named exception to "never
 * a command string": SSH `exec` takes one, run by the account's own shell). A fixed template of
 * two checked values — the PID digits and a signal of the list — and nothing else, ever:
 * `env LC_ALL=C` keeps the messages English for reading them back, `env` itself works in any
 * login shell. As administrator, `sudo -k -S -p ''`: asks every time (no cached sudo sign-in),
 * reads the password from stdin, prints no prompt.
 */
export function killCommand(
  pid: number,
  signal: ProcessSignal,
  asAdministrator: boolean,
): LinuxCommand {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > PROCESS_LIMITS.maxPid) {
    throw new Error('Not a PID');
  }
  if (!PROCESS_SIGNALS.includes(signal)) throw new Error('Not a signal');
  const kill = `kill -s ${signal} -- ${pid}`;
  return `env LC_ALL=C ${asAdministrator ? `sudo -k -S -p '' -- ${kill}` : kill}` as LinuxCommand;
}
