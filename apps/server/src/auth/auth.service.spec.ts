import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { PasswordHasher, SessionService, SignInService } from '@nestjs/authentication';
import type { AuditService } from '../audit/audit.service.js';
import type { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService, TooManyAttemptsException } from './login-throttle.service.js';
import { PasswordHashSlots } from './password-hash-slots.js';
import type { SetupService } from './setup.service.js';

const user = { id: 'u1', username: 'owner', createdAt: '2026-10-11T00:00:00.000Z' };

function setup({ known = true, valid = true, needsRehash = false } = {}) {
  const users = {
    findCredentials: vi.fn(async () =>
      known ? { id: user.id, username: user.username, passwordHash: '$scrypt$stored' } : null,
    ),
    findById: vi.fn(async () => user),
    updatePasswordHash: vi.fn(async () => undefined),
  };
  const hasher = {
    verify: vi.fn(async () => valid),
    needsRehash: vi.fn(() => needsRehash),
    hash: vi.fn(async () => '$scrypt$fresh'),
  };
  const signIn = { signIn: vi.fn(async () => undefined) };
  const audit = { tryRecord: vi.fn(async () => undefined) };
  const service = new AuthService(
    users as unknown as UsersService,
    hasher as unknown as PasswordHasher,
    signIn as unknown as SignInService,
    {} as SessionService,
    new LoginThrottleService(),
    audit as unknown as AuditService,
    {} as SetupService,
    new PasswordHashSlots(),
  );
  return { service, users, hasher, signIn, audit };
}

describe('AuthService.login', () => {
  it('still runs a password check for an unknown user (dummy hash: no timing leak)', async () => {
    const { service, hasher } = setup({ known: false, valid: false });
    await expect(service.login({ username: 'nobody', password: 'x' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(hasher.verify).toHaveBeenCalledWith('x', undefined);
  });

  it('never re-hashes or signs in on a failed check', async () => {
    const { service, hasher, signIn, users } = setup({ valid: false, needsRehash: true });
    await expect(service.login({ username: 'owner', password: 'x' })).rejects.toThrow();
    expect(hasher.needsRehash).not.toHaveBeenCalled();
    expect(users.updatePasswordHash).not.toHaveBeenCalled();
    expect(signIn.signIn).not.toHaveBeenCalled();
  });

  it('re-hashes outdated hashes after a successful check, then signs in', async () => {
    const { service, users, signIn } = setup({ needsRehash: true });
    await expect(service.login({ username: 'owner', password: 'pw' })).resolves.toEqual(user);
    expect(users.updatePasswordHash).toHaveBeenCalledWith('u1', '$scrypt$fresh');
    expect(signIn.signIn).toHaveBeenCalledWith('u1', { method: 'password' });
  });

  it('records failures without the password', async () => {
    const { service, audit } = setup({ valid: false });
    await expect(
      service.login({ username: 'owner', password: 'secret-attempt' }, '10.0.0.5'),
    ).rejects.toThrow();
    expect(audit.tryRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', outcome: 'failure', ip: '10.0.0.5' }),
    );
    expect(JSON.stringify(audit.tryRecord.mock.calls)).not.toContain('secret-attempt');
  });
});

describe('AuthService: delays and limits', () => {
  const OWNER = { username: 'owner', password: 'pw' };

  it('failed sign-ins from another address never delay the owner’s', async () => {
    const { service, hasher } = setup();
    hasher.verify.mockResolvedValueOnce(false);
    await expect(service.login({ ...OWNER, password: 'guess' }, '198.51.100.9')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.login(OWNER, '192.168.1.20')).resolves.toEqual(user);
  });

  it('the same address (or IPv6 /64) waits after a failure, without a password check', async () => {
    const { service, hasher } = setup({ valid: false });
    await expect(service.login(OWNER, '2001:db8::1')).rejects.toThrow(UnauthorizedException);
    hasher.verify.mockClear();
    await expect(service.login(OWNER, '2001:db8::2')).rejects.toBeInstanceOf(
      TooManyAttemptsException,
    );
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('failed sign-ins never block a signed-in confirmation; wrong confirmations have their own delay', async () => {
    const { service, hasher } = setup();
    hasher.verify.mockResolvedValueOnce(false);
    await expect(service.login(OWNER, '192.168.1.20')).rejects.toThrow(UnauthorizedException);
    await expect(service.confirmPassword(user, 'pw', '192.168.1.20')).resolves.toBeUndefined();
    hasher.verify.mockResolvedValueOnce(false);
    await expect(service.confirmPassword(user, 'wrong')).rejects.toThrow(BadRequestException);
    await expect(service.confirmPassword(user, 'pw')).rejects.toBeInstanceOf(
      TooManyAttemptsException,
    );
    await expect(service.login(OWNER, '192.168.1.30')).resolves.toEqual(user);
  });

  it('a sign-in while every hashing slot is taken is answered 429 at once', async () => {
    const { service, hasher } = setup();
    const finish: (() => void)[] = [];
    hasher.verify.mockImplementation(
      () => new Promise<boolean>((resolve) => finish.push(() => resolve(true))),
    );
    const running = [service.login(OWNER, '10.0.0.1'), service.login(OWNER, '10.0.0.2')];
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    await expect(service.login(OWNER, '10.0.0.3')).rejects.toBeInstanceOf(TooManyAttemptsException);
    expect(hasher.verify).toHaveBeenCalledTimes(2);
    finish.forEach((done) => done());
    await Promise.all(running);
  });
});
