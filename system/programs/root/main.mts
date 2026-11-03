// The actions laris-root does: the helper's privileged branches, run here as root. Each is the
// helper's own code for it (helper/), asked only in its privileged form — anything else is refused.

import { privileged, signalProcess } from '../helper/actions.mts';
import { BAD_REQUEST, ok, type Answer, type Request } from '../helper/answers.mts';
import { removeVolumes, startSystemTask } from '../helper/apps.mts';
import { FAKE_BIN, ROOT_IDLE_MS } from '../helper/config.mts';
import { serve } from '../helper/main.mts';
import { removePaths } from '../helper/paths.mts';
import { runRoot } from '../helper/root.mts';
import { controlUnit } from '../helper/units.mts';

function handle(request: Request): Promise<Answer> | Answer {
  // Unlocking while unlocked: the idle time starts again.
  if (request['action'] === 'touch') return ok();
  // The same test the helper forwards by: only the privileged form of an action. A system task
  // comes as its unit alone (the helper makes its files first).
  if (!privileged(request) && request['action'] !== 'app.task') return BAD_REQUEST;
  switch (request['action']) {
    case 'root.run':
      return runRoot(request);
    case 'process.signal':
      return signalProcess(request);
    case 'paths.remove':
      return removePaths(request);
    case 'volumes.remove':
      return removeVolumes(request);
    case 'app.task':
      return startSystemTask(request);
    case 'units.control':
      return controlUnit(request);
    default:
      return BAD_REQUEST;
  }
}

export function start(): void {
  // Started by sudo, it's root; anything else is a mistake (tests run it with fake programs).
  if (process.getuid?.() !== 0 && !FAKE_BIN) {
    process.stdout.write(`${JSON.stringify({ 'laris-root': 1, error: 'not_root' })}\n`);
    process.exit(6);
  }
  serve('laris-root', handle, { idleMs: ROOT_IDLE_MS });
}
