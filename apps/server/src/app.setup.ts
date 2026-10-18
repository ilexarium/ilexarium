import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { join } from 'node:path';
import { WsAdapter } from '@nestjs/platform-ws';
import { config as rxjsConfig } from 'rxjs';
import { applyTrustProxy } from './common/trust-proxy.js';
import type { Env } from './config/env.schema.js';

/**
 * Everything the running app is configured with beyond its modules. Shared by `main.ts` and the
 * e2e tests, so tests exercise exactly what production runs.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // An error that reached a stream's end: logged — RxJS would otherwise throw it later, outside
  // any handler, and stop the server. (Streams catch their own errors; this is the safety net.)
  rxjsConfig.onUnhandledError = (error: unknown) =>
    new Logger('RxJS').error(
      'Unhandled error in a stream',
      error instanceof Error ? error.stack : error,
    );
  app.setGlobalPrefix('api');
  const webRoot = config.get('WEB_ROOT', { infer: true });
  if (webRoot) serveWebApp(app, webRoot);
  applyTrustProxy(app, config.get('TRUST_PROXY', { infer: true }));
  // Refuses state-changing requests from other origins (with the session cookie's SameSite=Lax).
  app.enableCsrfProtection();
  // Plain WebSockets (the `ws` library) for gateways, on the same HTTP server.
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  return app;
}

/**
 * The built web app on the same origin as the API (production): its files as they are — the
 * hashed ones cached for a year, index.html never — and index.html for every other page address,
 * so links into the app work. Never for /api (any case, like Express's routes: unknown API routes
 * stay JSON 404s), and never for a missing file (`chunk-OLD.js` after an update gets a 404, not
 * the page).
 */
function serveWebApp(app: NestExpressApplication, root: string): void {
  app.useStaticAssets(root, {
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res, path) => {
      // Angular names its build files by content hash: they never change.
      if (/-[A-Z0-9]{8,}\.(js|css|woff2?)$/.test(path)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else res.setHeader('Cache-Control', 'no-cache');
    },
  });
  const index = join(root, 'index.html');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const page = req.method === 'GET' || req.method === 'HEAD';
    const path = req.path.toLowerCase();
    const api = path === '/api' || path.startsWith('/api/');
    const file = /\.[a-z0-9]+$/.test(path.slice(path.lastIndexOf('/') + 1));
    if (!page || api || file) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index, (error) => {
      if (error) next(error);
    });
  });
}
