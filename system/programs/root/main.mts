// The actions laris-root does: the helper's privileged branches, run here as root. Each is the
// helper's own code for it (helper/), asked only in its privileged form — anything else is refused.

import { signalProcess } from '../helper/actions.mts';
import { BAD_REQUEST, ok, type Answer, type Request } from '../helper/answers.mts';
import { checkCompose, removeVolumes, startSystemTask } from '../helper/apps.mts';
import { FAKE_BIN, ROOT_IDLE_MS } from '../helper/config.mts';
import { serve } from '../helper/main.mts';
import { removePaths } from '../helper/paths.mts';
import { runRoot } from '../helper/root.mts';

function handle(request: Request): Promise<Answer> | Answer {
  switch (request['action']) {
    // Unlocking while unlocked: the idle time starts again.
    case 'touch':
      return ok();
    case 'root.run':
      return runRoot(request);
    case 'process.signal':
      return request['administrator'] === true ? signalProcess(request) : BAD_REQUEST;
    case 'paths.remove':
      return request['administrator'] === true ? removePaths(request) : BAD_REQUEST;
    case 'compose.check':
      return request['docker'] === 'sudo' ? checkCompose(request) : BAD_REQUEST;
    case 'volumes.remove':
      return request['docker'] === 'sudo' ? removeVolumes(request) : BAD_REQUEST;
    case 'app.task':
      return startSystemTask(request);
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
  serve('laris-root', handle, ROOT_IDLE_MS);
}
