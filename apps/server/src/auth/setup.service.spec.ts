import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../config/env.schema.js';
import type { UsersService } from '../users/users.service.js';
import { normaliseSetupToken, SetupService } from './setup.service.js';

let dir: string;
let tokenFile: string;
let logged: string[];

function service({ hasUsers = false } = {}) {
  const users = { hasAnyUser: async () => hasUsers } as UsersService;
  const config = { get: () => tokenFile } as unknown as ConfigService<Env, true>;
  return new SetupService(users, config);
}

const readToken = async () => (await readFile(tokenFile, 'utf8')).trim();
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'homelab-setup-'));
  tokenFile = join(dir, 'nested', 'setup-token');
  logged = [];
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('SetupService', () => {
  it('writes a 128-bit token in readable groups while no user exists', async () => {
    const setup = service();
    await setup.onApplicationBootstrap();
    expect(setup.isPending()).toBe(true);
    // 26 base32 chars = 130 bits ≥ 128, grouped by four
    expect(await readToken()).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
  });

  it('makes the file readable only by its owner (0600)', async () => {
    await service().onApplicationBootstrap();
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  });

  it('never logs the token — only where it is', async () => {
    await service().onApplicationBootstrap();
    const token = await readToken();
    expect(logged.join('\n')).toContain(tokenFile);
    for (const form of [token, normaliseSetupToken(token)]) {
      expect(logged.join('\n')).not.toContain(form);
    }
  });

  it('accepts the token regardless of case, dashes and spaces', async () => {
    const setup = service();
    await setup.onApplicationBootstrap();
    const token = await readToken();
    expect(setup.verify(token)).toBe(true);
    expect(setup.verify(token.toLowerCase())).toBe(true);
    expect(setup.verify(` ${token.replaceAll('-', ' ')} `)).toBe(true);
    expect(setup.verify(normaliseSetupToken(token))).toBe(true);
  });

  it('rejects wrong tokens', async () => {
    const setup = service();
    await setup.onApplicationBootstrap();
    const token = await readToken();
    for (const wrong of ['', 'AAAA-BBBB', `${token}A`, token.slice(0, -1)]) {
      expect(setup.verify(wrong)).toBe(false);
    }
  });

  it('generates a fresh token on every start while setup is pending', async () => {
    await service().onApplicationBootstrap();
    const first = await readToken();
    const restarted = service();
    await restarted.onApplicationBootstrap();
    const second = await readToken();
    expect(second).not.toBe(first);
    expect(restarted.verify(first)).toBe(false);
    expect(restarted.verify(second)).toBe(true);
  });

  it('is single-use: complete() forgets the token and deletes the file', async () => {
    const setup = service();
    await setup.onApplicationBootstrap();
    const token = await readToken();
    await setup.complete();
    expect(setup.isPending()).toBe(false);
    expect(setup.verify(token)).toBe(false);
    expect(await exists(tokenFile)).toBe(false);
  });

  it('does nothing — and removes a stale file — once a user exists', async () => {
    await service().onApplicationBootstrap();
    const setup = service({ hasUsers: true });
    await setup.onApplicationBootstrap();
    expect(setup.isPending()).toBe(false);
    expect(await exists(tokenFile)).toBe(false);
  });

  it('replaces a planted symlink instead of writing through it', async () => {
    const victim = join(dir, 'victim');
    await writeFile(victim, 'original');
    await service().onApplicationBootstrap(); // creates the directory
    await rm(tokenFile);
    await symlink(victim, tokenFile);
    await service().onApplicationBootstrap();
    expect(await readFile(victim, 'utf8')).toBe('original');
    expect((await stat(tokenFile)).isFile()).toBe(true);
  });
});
