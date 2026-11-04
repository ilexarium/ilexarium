import { HttpException, Injectable } from '@nestjs/common';
import { FILES_ERROR_CODES, type MachineCheckDocker, type PersonCheck } from '@laris/shared';
import { SystemReader } from '../host/system-reader.js';
import { LinuxSessions } from '../linux-sessions/linux-sessions.js';
import { CHECK_TIMEOUT_MS } from './machine-check.constants.js';

const NOT_CHECKED = { userUnits: null, lingering: null, docker: null } as const;

/**
 * Is this machine set up the way Laris needs (docs/plans/machine_check.md)? The steps done as the
 * signed-in person through their helper — nothing new of its own: `hello` and `docker.access`.
 * Lingering is read from the host: in the session the user manager runs anyway, so a user unit
 * starting there doesn't say it keeps running after the Linux sign-in ends.
 */
@Injectable()
export class MachineCheckService {
  constructor(
    private readonly linuxSessions: LinuxSessions,
    private readonly systemReader: SystemReader,
  ) {}

  async person(appSessionId: string): Promise<PersonCheck> {
    const session = this.linuxSessions.current(appSessionId);
    try {
      const hello = await this.linuxSessions.ask(appSessionId, { action: 'hello' });
      if (!hello.ok) return { helper: 'unavailable', ...NOT_CHECKED };
      const user = hello['user'];
      if (typeof user !== 'string' || user !== session?.username) {
        return { helper: 'wrong_account', ...NOT_CHECKED };
      }
      const access = await this.linuxSessions.ask(
        appSessionId,
        { action: 'docker.access' },
        { timeoutMs: CHECK_TIMEOUT_MS },
      );
      if (!access.ok) return { helper: 'unavailable', ...NOT_CHECKED };
      const userUnits = access['userUnits'] === true;
      let docker: MachineCheckDocker = 'system_units';
      if (userUnits && access['unitDocker'] === true) docker = 'user_units';
      else if (userUnits && access['loginDocker'] === true) docker = 'restart_needed';
      const lingering = await this.systemReader.lingering(user);
      return { helper: 'ok', userUnits, lingering, docker };
    } catch (error) {
      if (codeOf(error) === FILES_ERROR_CODES.helperUnavailable) {
        return { helper: 'unavailable', ...NOT_CHECKED };
      }
      throw error;
    }
  }
}

function codeOf(error: unknown): unknown {
  if (!(error instanceof HttpException)) return undefined;
  return (error.getResponse() as { code?: unknown }).code;
}
