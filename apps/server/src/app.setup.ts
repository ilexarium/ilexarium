import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyTrustProxy } from './common/trust-proxy.js';
import type { Env } from './config/env.schema.js';

/**
 * Everything the running app is configured with beyond its modules. Shared by `main.ts` and the
 * e2e tests, so tests exercise exactly what production runs.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  app.setGlobalPrefix('api');
  applyTrustProxy(app, config.get('TRUST_PROXY', { infer: true }));
  app.enableShutdownHooks();
  return app;
}
