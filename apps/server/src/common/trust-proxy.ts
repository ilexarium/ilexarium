import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env.schema.js';

const logger = new Logger('TrustProxy');

const MISCONFIGURED_MESSAGE =
  'Requests contain X-Forwarded-For but TRUST_PROXY is not set. If this app is behind a ' +
  'reverse proxy, set TRUST_PROXY (e.g. "loopback"); otherwise client IPs are wrong — ' +
  'every client shares one throttling limit and audit IPs are useless.';

/**
 * Express middleware that logs MISCONFIGURED_MESSAGE once, the first time a request carries
 * X-Forwarded-For while proxy headers are ignored. Harmless if a client sends the header itself:
 * one log line, no change in how requests are handled.
 */
export function createForwardedHeaderWarning(warn: (message: string) => void) {
  let warned = false;
  return (request: Request, _response: Response, next: NextFunction) => {
    if (!warned && request.headers['x-forwarded-for'] !== undefined) {
      warned = true;
      warn(MISCONFIGURED_MESSAGE);
    }
    next();
  };
}

/**
 * Decides whose X-Forwarded-* headers Express believes (`request.ip`, `request.secure`).
 * `false`: nobody's — the default, for no proxy. Otherwise only the listed proxies
 * ("loopback", IPs, CIDRs). "Trust everyone" is impossible: the env schema rejects it.
 */
export function applyTrustProxy(app: NestExpressApplication, trustProxy: Env['TRUST_PROXY']) {
  app.set('trust proxy', trustProxy);
  if (trustProxy === false) {
    app.use(createForwardedHeaderWarning((message) => logger.warn(message)));
  }
}
