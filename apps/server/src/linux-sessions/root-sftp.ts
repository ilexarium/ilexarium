import { createRequire } from 'node:module';
import type { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import {
  ROOT_SFTP_COMMANDS,
  ROOT_SFTP_MESSAGES,
  ROOT_SFTP_TIMEOUT_MS,
} from './linux-sessions.constants.js';
import type { RootSftpFailure } from './linux-sessions.model.js';

interface ChannelInfo {
  type: string;
  incoming: { id: number };
  outgoing: unknown;
}
type SftpClass = new (
  client: Client,
  channel: ChannelInfo,
  config: object,
) => SFTPWrapper & { _init(): void; stderr: unknown };

// ssh2 opens SFTP only as the account's own subsystem; root's is a command (sudo … sftp-server),
// so its channel is handed to ssh2's own SFTP class — not part of ssh2's public API. ssh2 is
// pinned, and the e2e test opens a real one: an update that changes this fails there.
const { SFTP } = createRequire(import.meta.url)('ssh2/lib/protocol/SFTP.js') as {
  SFTP: SftpClass;
};

export class RootSftpError extends Error {
  constructor(
    readonly reason: RootSftpFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * SFTP as root on the account's SSH connection, through its own sudo: without a password first
 * (sudo that needs none), then with it. Fails with a `RootSftpError`; the password is written once,
 * to sudo, and kept nowhere.
 */
export async function openRootSftp(client: Client, password: string): Promise<SFTPWrapper> {
  try {
    return await attempt(client, null);
  } catch (error) {
    if (!(error instanceof RootSftpError && error.reason === 'password_required')) throw error;
    return attempt(client, password);
  }
}

function attempt(client: Client, password: string | null): Promise<SFTPWrapper> {
  const command =
    password === null ? ROOT_SFTP_COMMANDS.withoutPassword : ROOT_SFTP_COMMANDS.withPassword;
  return new Promise((resolve, reject) => {
    client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
      if (error) return reject(new RootSftpError('failed', error.message));
      let settled = false;
      let said = '';
      const fail = (reason: RootSftpFailure, message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.close();
        reject(new RootSftpError(reason, message));
      };
      const timer = setTimeout(() => fail('timed_out', 'sudo gave no SFTP answer'), ROOT_SFTP_TIMEOUT_MS);
      // Known refusals end it at once; anything else sudo says (a lecture) waits for the answer.
      channel.stderr.on('data', (data: Buffer) => {
        said = (said + data.toString()).slice(-2000);
        if (ROOT_SFTP_MESSAGES.passwordRequired.test(said)) fail('password_required', said.trim());
        else if (ROOT_SFTP_MESSAGES.wrongPassword.test(said)) fail('wrong_password', said.trim());
        else if (ROOT_SFTP_MESSAGES.notAllowed.test(said)) fail('not_allowed', said.trim());
      });
      if (password !== null) channel.write(`${password}\n`);

      const info = channel as unknown as ChannelInfo;
      const sftp = new SFTP(client, { type: 'session', incoming: info.incoming, outgoing: info.outgoing }, {});
      // After the hand-over ssh2 gives the channel's data to the SFTP class; sudo's messages
      // still come here.
      sftp.stderr = channel.stderr;
      (client as unknown as { _chanMgr: { update(id: number, channel: unknown): void } })._chanMgr.update(
        info.incoming.id,
        sftp,
      );
      sftp.once('ready', () => {
        if (settled) return sftp.end();
        settled = true;
        clearTimeout(timer);
        resolve(sftp);
      });
      sftp.once('error', (sftpError: Error) => fail('failed', sftpError.message));
      sftp.once('close', () => fail('failed', said.trim() || 'sudo ended'));
      sftp._init();
    });
  });
}
