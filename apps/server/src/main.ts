import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { listenOnSockets, passedSockets, socketMismatch } from './common/systemd-socket.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  const sockets = passedSockets(process.env, process.pid);
  for (const name of ['LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES']) delete process.env[name];
  const app = configureApp(await NestFactory.create<NestExpressApplication>(AppModule));
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  const host = config.get('HOST', { infer: true });
  if (sockets.length === 0) {
    await (host ? app.listen(port, host) : app.listen(port));
    return;
  }
  await app.init();
  const mismatch = socketMismatch(await listenOnSockets(app.getHttpServer(), sockets), host, port);
  if (mismatch) {
    await app.close();
    throw new Error(mismatch);
  }
}
await bootstrap();
