import type { ProcessSignal, PublicUser } from '@laris/shared';
import type { ClientChannel, Client, SFTPWrapper } from 'ssh2';
import type { LinuxHelper } from './linux-helper.js';

/** What the helper is asked (system/programs/laris-helper.mts lists the same). */
export type HelperRequest =
  | { action: 'hello' }
  | { action: 'sudo.unlock'; password: string }
  | { action: 'sudo.lock' }
  | { action: 'process.signal'; pid: number; signal: ProcessSignal; administrator: boolean }
  | { action: 'docker.access' }
  | {
      action: 'app.task';
      folder: string;
      project: string;
      task: 'up' | 'update' | 'down';
      system: boolean;
    }
  | { action: 'app.taskState'; unit: string; system: boolean }
  | { action: 'compose.check'; folder: string; project: string; docker: 'direct' | 'sudo' }
  | { action: 'compose.images'; folder: string; project: string; docker: 'direct' | 'sudo' }
  | { action: 'volumes.remove'; names: string[]; docker: 'direct' | 'sudo' }
  | { action: 'paths.size'; paths: string[] }
  | { action: 'paths.remove'; paths: string[]; administrator: boolean }
  | {
      action: 'root.run';
      program: 'backup' | 'disk';
      /** The program's own action. */
      command: string;
      input: string;
      timeoutMs?: number;
    };

/** Its answer; `ended` and `timed_out` also come from this side (the helper gone, no answer). */
export type HelperAnswer =
  { ok: true; [field: string]: unknown } | { ok: false; error: string; message?: string };

/** Why a Linux session closed. */
export type LinuxCloseReason =
  'idle' | 'app-sign-out' | 'closed' | 'locked' | 'replaced' | 'shutdown' | 'ended';

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
  gid: number | null;
  /** Its helper; null when it didn't start (Files and the terminal still work). */
  helper: LinuxHelper | null;
  /** Until when sudo is probably unlocked (ms); null: locked. */
  sudoUntil: number | null;
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
