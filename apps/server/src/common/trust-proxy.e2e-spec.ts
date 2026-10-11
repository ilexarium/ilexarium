import { Controller, Get, Ip, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import request from 'supertest';
import type { Env } from '../config/env.schema.js';
import { validateEnv } from '../config/env.schema.js';
import { applyTrustProxy, createForwardedHeaderWarning } from './trust-proxy.js';

@Controller('ip')
class IpController {
  @Get()
  ip(@Ip() ip: string) {
    return { ip };
  }
}

@Module({ controllers: [IpController] })
class IpModule {}

async function appWith(trustProxy: Env['TRUST_PROXY']) {
  const moduleRef = await Test.createTestingModule({ imports: [IpModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  applyTrustProxy(app, trustProxy);
  await app.init();
  return app;
}

describe('applyTrustProxy', () => {
  it('ignores a spoofed X-Forwarded-For when no proxy is trusted', async () => {
    const app = await appWith(false);
    const res = await request(app.getHttpServer()).get('/ip').set('X-Forwarded-For', '1.2.3.4');
    expect(res.body.ip).not.toBe('1.2.3.4');
    await app.close();
  });

  it('believes X-Forwarded-For from a trusted loopback proxy', async () => {
    const app = await appWith(['loopback']);
    const res = await request(app.getHttpServer()).get('/ip').set('X-Forwarded-For', '1.2.3.4');
    expect(res.body.ip).toBe('1.2.3.4');
    await app.close();
  });

  it('takes the address the trusted proxy saw, not one the client prepended', async () => {
    const app = await appWith(['loopback']);
    const res = await request(app.getHttpServer())
      .get('/ip')
      .set('X-Forwarded-For', '6.6.6.6, 192.168.1.50');
    expect(res.body.ip).toBe('192.168.1.50');
    await app.close();
  });

  it('cannot be configured to trust everyone', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost/db', TRUST_PROXY: 'true' }),
    ).toThrow();
  });
});

describe('createForwardedHeaderWarning', () => {
  const run = (middleware: ReturnType<typeof createForwardedHeaderWarning>, headers: object) => {
    const next = vi.fn();
    middleware({ headers } as Request, {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
  };

  it('warns once when X-Forwarded-For arrives while proxies are not trusted', () => {
    const warn = vi.fn();
    const middleware = createForwardedHeaderWarning(warn);
    run(middleware, {});
    expect(warn).not.toHaveBeenCalled();
    run(middleware, { 'x-forwarded-for': '1.2.3.4' });
    run(middleware, { 'x-forwarded-for': '1.2.3.4' });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('TRUST_PROXY');
  });
});
