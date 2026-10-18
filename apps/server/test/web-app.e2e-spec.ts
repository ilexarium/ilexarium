import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

// The built web app served by the app itself (production, WEB_ROOT): its files, index.html for
// every page address, never for /api.

describe('web app (e2e)', () => {
  let app: NestExpressApplication;
  let origin: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'web-root-'));
    const root = join(dir, 'browser');
    mkdirSync(root);
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><title>homelab</title><app-root></app-root>',
    );
    writeFileSync(join(root, 'main-ABCDEFGH.js'), 'console.log(1);');
    writeFileSync(join(root, '.secret'), 'never');
    writeFileSync(join(dir, 'outside.txt'), 'never');
    // Read when the config module loads: set before the app is imported.
    process.env.WEB_ROOT = root;
    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/app.setup.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    delete process.env.WEB_ROOT;
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page at / and at any page address (links into the app)', async () => {
    for (const path of ['/', '/backups', '/containers/web/logs', '/settings/notifications?x=1']) {
      const res = await request(origin).get(path).expect(200);
      expect(res.text, path).toContain('<app-root>');
      expect(res.headers['cache-control'], path).toBe('no-cache');
    }
  });

  it('serves its built files, the hashed ones cached for a year', async () => {
    const res = await request(origin).get('/main-ABCDEFGH.js').expect(200);
    expect(res.text).toBe('console.log(1);');
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('never answers /api with the page, in any case: unknown API routes stay JSON 404s', async () => {
    for (const path of ['/api/nothing-here', '/API/nothing-here', '/Api']) {
      const res = await request(origin).get(path).expect(404);
      expect(res.headers['content-type'], path).toMatch(/json/);
    }
    await request(origin).get('/api/health').expect(200);
  });

  it('answers a missing file with a 404, not the page (an old chunk after an update)', async () => {
    for (const path of ['/chunk-OLDHASH12.js', '/favicon.ico', '/assets/missing.svg']) {
      const res = await request(origin).get(path).expect(404);
      expect(res.text, path).not.toContain('<app-root>');
    }
  });

  it('serves no hidden files and nothing outside its folder', async () => {
    const hidden = await request(origin).get('/.secret');
    expect(hidden.text).not.toContain('never');
    for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2Foutside.txt']) {
      const res = await request(origin).get(path);
      expect(res.text, path).not.toContain('never');
    }
  });
});
