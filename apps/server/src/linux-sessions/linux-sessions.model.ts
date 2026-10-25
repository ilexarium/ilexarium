import type { PublicUser } from '@laris/shared';
import type { ClientChannel, Client, SFTPWrapper } from 'ssh2';

/**
 * A command line for the account's own shell (SSH `exec` takes one string). Only made by fixed
 * templates of checked values (`killCommand`, `UID_COMMAND`), never from text a request sent.
 */
export type LinuxCommand = string & { readonly linuxCommand: unique symbol };

/** How a command run on the Linux session ended. */
export interface LinuxCommandResult {
  /** Its exit code; null if it ended by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Why a Linux session closed. */
export type LinuxCloseReason =
  'idle' | 'app-sign-out' | 'closed' | 'replaced' | 'shutdown' | 'ended';

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
  uid: number | null;
  /** The app user who opened it (an "everywhere" sign-out closes all of theirs). */
  userId: string;
  /** Closes it after 30 minutes without use; refreshed on every use. */
  idle: NodeJS.Timeout;
  /** Called once when it closes, whatever the reason (the terminal ends with it). */
  closing: Set<(why: LinuxCloseReason) => void>;
}

/** A shell opened on a Linux session (the web terminal). */
export interface LinuxShell {
  channel: ClientChannel;
  username: string;
  /** Runs `listener` when the Linux session closes; returns the unsubscribe. */
  onSessionClose(listener: (why: LinuxCloseReason) => void): () => void;
}
