import type { PublicUser } from '@homelab/shared';
import type { Client, SFTPWrapper } from 'ssh2';

/** Who acts, for the audit log. */
export interface LinuxActor {
  user: PublicUser;
  ip?: string;
}

/** An open Linux session: its SSH connection and SFTP channel. */
export interface OpenLinuxSession {
  client: Client;
  sftp: SFTPWrapper;
  username: string;
  home: string;
  /** The app user who opened it (an "everywhere" sign-out closes all of theirs). */
  userId: string;
  /** Closes it after 30 minutes without use; refreshed on every use. */
  idle: NodeJS.Timeout;
}
