import type { ListenOptions } from 'node:net';

export interface PassedSocket {
  fd: number;
  /** The socket unit it comes from (LISTEN_FDNAMES), or '' when systemd didn't say. */
  name: string;
}

/** A socket unit and the settings in app.env that say where it listens. */
export interface SocketUnit {
  unit: string;
  host: string;
  port: string;
  /** Where it listens when the host setting is unset; none: unset means off. */
  defaultHost?: string;
  /** How to move it. */
  hint: string;
}

export interface Certificate {
  cert: Buffer;
  key: Buffer;
}

/** A socket from systemd (`{ fd }`), or an address to listen on (tests). */
export type ListenTarget = { fd: number } | ListenOptions;
