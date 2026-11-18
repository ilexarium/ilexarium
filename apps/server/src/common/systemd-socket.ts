import type { Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import {
  FIRST_PASSED_FD,
  MAX_PASSED_SOCKETS,
  MIN_TLS_VERSION,
  PLAIN_SOCKET,
} from './systemd-socket.constants.js';
import type {
  Certificate,
  ListenTarget,
  PassedSocket,
  SocketUnit,
} from './systemd-socket.model.js';

/**
 * The listening sockets systemd passed to this process (ilex.socket and ilex-https.socket, in
 * production): LISTEN_FDS of them from 3, each named after its unit by LISTEN_FDNAMES, only when
 * LISTEN_PID names this process — none otherwise (the app listens on HOST and PORT itself). A
 * count the two units never pass throws.
 */
export function passedSockets(env: NodeJS.ProcessEnv, pid: number): PassedSocket[] {
  if (env['LISTEN_PID'] !== String(pid)) return [];
  const count = env['LISTEN_FDS'] ?? '';
  if (!/^[1-9]\d*$/.test(count) || Number(count) > MAX_PASSED_SOCKETS) {
    throw new Error(
      `LISTEN_FDS=${count}: ilex.socket and ilex-https.socket pass 1 to ${MAX_PASSED_SOCKETS} sockets`,
    );
  }
  const names = (env['LISTEN_FDNAMES'] ?? '').split(':');
  return Array.from({ length: Number(count) }, (_, index) => ({
    fd: FIRST_PASSED_FD + index,
    name: names[index] ?? '',
  }));
}

/**
 * Why a unit's sockets aren't where its settings say, or null. The rule of the generator
 * (system/systemd/ilex-socket-generator) for both units: the host setting's own address on the
 * port, and beside 127.0.0.1 or 0.0.0.0 also ::1, beside ::1 also 127.0.0.1 — "localhost"
 * reaches the app whichever one a client picks. That second one may be missing (a machine
 * without IPv6), the host's own not. Without a host setting or default (HTTPS turned off), the
 * unit passes nothing.
 */
export function socketMismatch(
  listening: AddressInfo[],
  host: string | undefined,
  port: number,
  socket: SocketUnit = PLAIN_SOCKET,
): string | null {
  const where = listening.map((one) => addressText(one.address, one.port)).join(', ');
  const setting = host ?? socket.defaultHost;
  if (setting === undefined) {
    if (listening.length === 0) return null;
    return `${socket.unit} listens on ${where}, but ${socket.host} is not set. ${socket.hint}`;
  }
  const own = canonical(setting);
  const beside =
    own === '127.0.0.1' || own === '0.0.0.0' ? '::1' : own === '::1' ? '127.0.0.1' : '';
  const fits =
    listening.some((one) => one.address === own) &&
    listening.every((one) => one.port === port && (one.address === own || one.address === beside));
  if (fits) return null;
  return (
    `${socket.unit} listens on ${where || 'nothing'} — not on ${addressText(own, port)} as ` +
    `${socket.host} and ${socket.port} say. ${socket.hint}`
  );
}

/**
 * Listens on systemd's sockets: the HTTP server on the first plain one; the other sockets'
 * connections handed to it — one server for the API and both WebSocket paths. An HTTPS socket's
 * connections are decrypted first (what Node's own https.Server is inside) and stay encrypted
 * for their whole life, upgrades too; Express sees the TLS socket, so `request.secure` holds.
 * The others stop with the server; a connection one takes while it closes is dropped.
 */
export async function listenOnSockets(
  server: HttpServer,
  plain: ListenTarget[],
  encrypted: ListenTarget[] = [],
  certificate?: Certificate,
): Promise<{ plain: AddressInfo[]; encrypted: AddressInfo[] }> {
  const [first, ...rest] = plain;
  if (first === undefined) throw new Error('No socket to listen on');
  if (encrypted.length > 0 && certificate === undefined) {
    throw new Error('An HTTPS socket needs a certificate');
  }
  const handOver = (connection: Socket) => {
    if (server.listening) server.emit('connection', connection);
    else connection.destroy();
  };
  await listenOn(server, first);
  const others = await Promise.all(
    rest.map(async (options) => {
      const other = createServer(handOver);
      await listenOn(other, options);
      return other;
    }),
  );
  // A browser that refuses the certificate ends its handshake: Node drops that connection itself
  // (tlsClientError), nothing of the app's.
  const secure = await Promise.all(
    encrypted.map(async (options) => {
      const other = createTlsServer({ ...certificate, minVersion: MIN_TLS_VERSION }, handOver);
      await listenOn(other, options);
      return other;
    }),
  );
  server.once('close', () => {
    for (const other of [...others, ...secure]) other.close();
  });
  return {
    plain: [server, ...others].map(addressOf),
    encrypted: secure.map(addressOf),
  };
}

function listenOn(server: Server, options: ListenTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function addressOf(listener: Server): AddressInfo {
  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new Error('A socket from systemd is not a TCP socket');
  }
  return address;
}

/** An IPv6 address as Node writes a listening one (`fd00:0::5` → `fd00::5`); IPv4 as it is. */
function canonical(address: string): string {
  return address.includes(':') ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
}

function addressText(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}
