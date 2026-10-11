import type { AddressInfo } from 'node:net';
import { PasswordHasher } from '@nestjs/authentication';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { REALTIME_PATH, type ServerMessage, serverMessageSchema } from '@homelab/shared';
import request from 'supertest';
import { WebSocket } from 'ws';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { resetDatabase } from './database.js';

const PASSWORD = 'correct horse battery';
/** Cheap scrypt for tests; override `PasswordHasher` with it in the testing module. */
export const testHasher = new PasswordHasher({ logN: 11 });

/** A test client: everything received, and how it closed. */
export class Client {
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Signs this socket's session out over HTTP (set by `connectSignedIn`). */
  signOut: () => Promise<void> = () => Promise.reject(new Error('Not signed in'));
  private waiters: (() => void)[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      // Every message the server sends must match the shared protocol.
      this.messages.push(serverMessageSchema.parse(JSON.parse((raw as Buffer).toString('utf8'))));
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) =>
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
  }

  get events(): string[] {
    return this.messages.map((message) => message.event);
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Resolves once `count` messages have arrived in total; each wait times out after `timeoutMs`. */
  async received(count: number, timeoutMs = 2000): Promise<ServerMessage[]> {
    while (this.messages.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out at ${this.messages.length}/${count} messages`)),
          timeoutMs,
        );
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages;
  }

  /** A round trip: by the time an `error` reply arrives, everything sent before was handled. */
  async flush(): Promise<void> {
    const count = this.messages.length;
    this.send({ event: 'subscribe', data: { topic: 'nope' } });
    await this.received(count + 1);
    this.messages.pop();
  }
}

/**
 * Starts listening on a free port, creates the owner, signs in and opens a socket the way the
 * app's own page would. For e2e tests of a realtime topic.
 */
export async function connectSignedIn(app: NestExpressApplication): Promise<Client> {
  await app.listen(0, '127.0.0.1');
  const host = `127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  await resetDatabase(app.get(PrismaService));
  await app.get(UsersService).create({
    username: 'owner',
    passwordHash: await testHasher.hash(PASSWORD),
  });
  const login = await request(`http://${host}`)
    .post('/api/auth/login')
    .set('Origin', `http://${host}`)
    .send({ username: 'owner', password: PASSWORD })
    .expect(200);
  const cookie = ([] as string[])
    .concat(login.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('__Host-sid='))!
    .split(';')[0];
  const client = new Client(
    new WebSocket(`ws://${host}${REALTIME_PATH}`, {
      headers: { Cookie: cookie },
      origin: `http://${host}`,
    }),
  );
  client.signOut = async () => {
    await request(`http://${host}`)
      .post('/api/auth/logout')
      .set('Origin', `http://${host}`)
      .set('Cookie', cookie)
      .expect(204);
  };
  await new Promise((resolve) => client.socket.once('open', resolve));
  return client;
}
