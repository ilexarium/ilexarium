import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { readCertificate } from './common/https-certificate.js';
import {
  HTTPS_SOCKET,
  MOVE_SOCKET_HINT,
  NO_SOCKET_MESSAGE,
  PLAIN_SOCKET,
} from './common/systemd-socket.constants.js';
import { listenOnSockets, passedSockets, socketMismatch } from './common/systemd-socket.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  const sockets = passedSockets(process.env, process.pid);
  for (const name of ['LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES']) delete process.env[name];
  // In production the ports are the socket units': systemd holds them while the app is down, so
  // no other program on the machine can take them. Binding them here instead would give that up
  // unnoticed.
  if (sockets.length === 0 && process.env['NODE_ENV'] === 'production') {
    throw new Error(`${NO_SOCKET_MESSAGE} ${MOVE_SOCKET_HINT}`);
  }
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  const host = config.get('HOST', { infer: true });
  if (sockets.length === 0) {
    await (host ? app.listen(port, host) : app.listen(port));
    return;
  }
  const encrypted = sockets.filter((socket) => socket.name === HTTPS_SOCKET.unit);
  const plain = sockets.filter((socket) => socket.name !== HTTPS_SOCKET.unit);
  const certificate =
    encrypted.length > 0
      ? await readCertificate(
          config.get('TLS_CERT_FILE', { infer: true }),
          config.get('TLS_KEY_FILE', { infer: true }),
        )
      : undefined;
  await app.init();
  const listening = await listenOnSockets(
    app.getHttpServer(),
    plain.map(({ fd }) => ({ fd })),
    encrypted.map(({ fd }) => ({ fd })),
    certificate,
  );
  const mismatch =
    socketMismatch(listening.plain, host, port, PLAIN_SOCKET) ??
    socketMismatch(
      listening.encrypted,
      config.get('HTTPS_HOST', { infer: true }),
      config.get('HTTPS_PORT', { infer: true }),
      HTTPS_SOCKET,
    );
  if (mismatch) {
    await app.close();
    throw new Error(mismatch);
  }
}
await bootstrap();
