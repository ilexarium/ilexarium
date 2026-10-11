import { UnauthorizedException } from '@nestjs/common';
import type { PasswordHasher, SessionService, SignInService } from '@nestjs/authentication';
import type { AuditService } from '../audit/audit.service.js';
import type { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

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
