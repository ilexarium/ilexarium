import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import { ROOT_SFTP_COMMANDS } from './linux-sessions.constants.js';
import { openRootSftp, RootSftpError } from './root-sftp.js';

/** SFTP's answer to its INIT: VERSION 3. */
const VERSION = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]);

/**
 * An SSH connection whose commands answer as `sudo` would: `say` is what sudo writes on stderr for
 * each command (nothing: sftp-server starts and answers SFTP's INIT).
 */
function fakeClient(say: Partial<Record<string, string>>) {
  const commands: string[] = [];
  const written: string[] = [];
  const closed: string[] = [];
  const handedOver: { push(data: Buffer | null): void }[] = [];
  const sent: Buffer[] = [];
  const client = {
    _protocol: {
      channelData: (_id: number, data: Buffer) => {
        sent.push(data);
        // sftp-server answers INIT once sudo started it.
        const command = commands.at(-1)!;
        if (say[command] === undefined) setImmediate(() => handedOver.at(-1)!.push(VERSION));
      },
      channelClose: () => undefined,
    },
    _chanMgr: { update: (_id: number, sftp: { push(data: Buffer | null): void }) => handedOver.push(sftp) },
    exec(command: string, done: (error: Error | undefined, channel: unknown) => void) {
      commands.push(command);
      const stderr = new EventEmitter();
      const channel = {
        stderr,
        incoming: { id: commands.length, window: 2 ** 21, packetSize: 32768, state: 'open' },
        outgoing: { id: commands.length, window: 2 ** 21, packetSize: 32768, state: 'open' },
        write: (text: string) => written.push(text),
        close: () => closed.push(command),
      };
      done(undefined, channel);
      const message = say[command];
      if (message !== undefined) setImmediate(() => stderr.emit('data', Buffer.from(message)));
    },
  };
  return { client: client as unknown as Client, commands, written, closed, sent };
}

describe('openRootSftp', () => {
  it('sudo needs no password: started without writing one', async () => {
    const fake = fakeClient({});
    const sftp = await openRootSftp(fake.client, 'pw');
    expect(sftp).toBeDefined();
    expect(fake.commands).toEqual([ROOT_SFTP_COMMANDS.withoutPassword]);
    expect(fake.written).toEqual([]);
    // SFTP's INIT went out on the channel.
    expect(fake.sent[0]).toEqual(Buffer.from([0, 0, 0, 5, 1, 0, 0, 0, 3]));
  });

  it('a password required: asked once more with it as the one line sudo reads', async () => {
    const fake = fakeClient({ [ROOT_SFTP_COMMANDS.withoutPassword]: 'sudo: a password is required\n' });
    await openRootSftp(fake.client, 'pw');
    expect(fake.commands).toEqual([
      ROOT_SFTP_COMMANDS.withoutPassword,
      ROOT_SFTP_COMMANDS.withPassword,
    ]);
    expect(fake.written).toEqual(['pw\n']);
    expect(fake.closed).toEqual([ROOT_SFTP_COMMANDS.withoutPassword]);
  });

  it.each([
    ['Sorry, try again.\n', 'wrong_password'],
    ['Sorry, user anna is not allowed to execute \'/usr/lib/openssh/sftp-server\' as root.\n', 'not_allowed'],
  ])('sudo says %j: fails at once as %s, the channel closed', async (message, reason) => {
    const fake = fakeClient({
      [ROOT_SFTP_COMMANDS.withoutPassword]: 'sudo: a password is required\n',
      [ROOT_SFTP_COMMANDS.withPassword]: message,
    });
    const error = await openRootSftp(fake.client, 'pw').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RootSftpError);
    expect((error as RootSftpError).reason).toBe(reason);
    expect(fake.closed).toContain(ROOT_SFTP_COMMANDS.withPassword);
  });

  it('the commands are fixed: sudo by its path, sftp-server after --, its cache never used', () => {
    expect(ROOT_SFTP_COMMANDS).toEqual({
      withoutPassword: '/usr/bin/env LC_ALL=C /usr/bin/sudo -n -k -- /usr/lib/openssh/sftp-server',
      withPassword: "/usr/bin/env LC_ALL=C /usr/bin/sudo -k -S -p '' -- /usr/lib/openssh/sftp-server",
    });
  });
});
