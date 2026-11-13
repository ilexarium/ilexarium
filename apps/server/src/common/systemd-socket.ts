import type { Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import {
  FIRST_PASSED_FD,
  MAX_PASSED_SOCKETS,
  MOVE_SOCKET_HINT,
} from './systemd-socket.constants.js';

/**
 * The listening sockets systemd passed to this process (ilex.socket, in production), as file
 * descriptors: LISTEN_FDS of them from 3, only when LISTEN_PID names this process — none
 * otherwise (the app listens on HOST and PORT itself). A count ilex.socket never passes throws.
 */
export function passedSockets(env: NodeJS.ProcessEnv, pid: number): number[] {
  if (env['LISTEN_PID'] !== String(pid)) return [];
  const count = env['LISTEN_FDS'] ?? '';
  if (!/^[1-9]\d*$/.test(count) || Number(count) > MAX_PASSED_SOCKETS) {
    throw new Error(`LISTEN_FDS=${count}: ilex.socket passes 1 to ${MAX_PASSED_SOCKETS} sockets`);
  }
  return Array.from({ length: Number(count) }, (_, index) => FIRST_PASSED_FD + index);
}

/**
 * Why systemd's sockets aren't where HOST and PORT say, or null. The rule of ilex.socket's
 * generator (system/systemd/ilex-socket-generator): HOST's own address (unset: 127.0.0.1, the
 * production default) on PORT, and beside 127.0.0.1 or 0.0.0.0 also ::1, beside ::1 also
 * 127.0.0.1 — "localhost" reaches the app whichever one a proxy picks. That second one may be
 * missing (a machine without IPv6), HOST's own not.
 */
export function socketMismatch(
  listening: AddressInfo[],
  host: string | undefined,
  port: number,
): string | null {
  const own = canonical(host ?? '127.0.0.1');
  const beside =
    own === '127.0.0.1' || own === '0.0.0.0' ? '::1' : own === '::1' ? '127.0.0.1' : '';
  const fits =
    listening.some((socket) => socket.address === own) &&
    listening.every(
      (socket) => socket.port === port && (socket.address === own || socket.address === beside),
    );
  if (fits) return null;
  const where = listening.map((socket) => addressText(socket.address, socket.port)).join(', ');
  return (
    `ilex.socket listens on ${where || 'nothing'} — not on ${addressText(own, port)} as HOST ` +
    `and PORT say. ${MOVE_SOCKET_HINT}`
  );
}

/**
 * Listens on systemd's sockets: the HTTP server on the first, the other's connections handed to
 * it — one server for the API and both WebSocket paths. The other stops with it; a connection it
 * takes while the server closes is dropped.
 */
export async function listenOnSockets(server: HttpServer, fds: number[]): Promise<AddressInfo[]> {
  const [first, ...rest] = fds;
  if (first === undefined) throw new Error('No socket to listen on');
  await listenOn(server, first);
  const others = await Promise.all(
    rest.map(async (fd) => {
      const other = createServer((connection) => {
        if (server.listening) server.emit('connection', connection);
        else connection.destroy();
      });
      await listenOn(other, fd);
      return other;
    }),
  );
  server.once('close', () => {
    for (const other of others) other.close();
  });
  return [server, ...others].map((listener) => {
    const address = listener.address();
    if (address === null || typeof address === 'string') {
      throw new Error('A socket from systemd is not a TCP socket');
    }
    return address;
  });
}

function listenOn(server: Server, fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ fd }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** An IPv6 address as Node writes a listening one (`fd00:0::5` → `fd00::5`); IPv4 as it is. */
function canonical(address: string): string {
  return address.includes(':') ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
}

function addressText(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}
