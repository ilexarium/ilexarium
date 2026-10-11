import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PasswordHasher, SessionService, SignInService } from '@nestjs/authentication';
import {
  AUTH_ERROR_CODES,
  type ApiErrorResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type PublicUser,
} from '@homelab/shared';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

/** Same response for an unknown username and a wrong password: no account enumeration. */
const INVALID_CREDENTIALS: ApiErrorResponse = {
  message: 'Invalid username or password',
  code: AUTH_ERROR_CODES.invalidCredentials,
};

/** A 400 on the field, never a 401: a 401 would make the web app sign the user out. */
const WRONG_CURRENT_PASSWORD: ApiErrorResponse = {
  message: 'Validation failed',
  errors: [
    {
      field: 'currentPassword',
      code: AUTH_ERROR_CODES.wrongPassword,
      message: 'Current password is incorrect',
    },
  ],
};

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly hasher: PasswordHasher,
    private readonly signIn: SignInService,
    private readonly sessions: SessionService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Verifies the password and signs this browser in (the package sets the session cookie).
   * Success is audited through the package's sign-in event; failures are audited here.
   */
  async login({ username, password }: LoginRequest, ip?: string): Promise<PublicUser> {
    this.throttle.assertAllowed(username);
    const credentials = await this.users.findCredentials(username);
    // Unknown user: verify against the hasher's dummy hash, so timing reveals nothing.
    const valid = await this.hasher.verify(password, credentials?.passwordHash);
    if (!credentials || !valid) {
      this.throttle.recordFailure(username);
      await this.audit.tryRecord({
        action: 'auth.login',
        outcome: 'failure',
        userId: credentials?.id,
        username,
        ip,
        details: { reason: AUTH_ERROR_CODES.invalidCredentials },
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    this.throttle.reset(username);
    if (this.hasher.needsRehash(credentials.passwordHash)) {
      await this.users.updatePasswordHash(credentials.id, await this.hasher.hash(password));
    }
    await this.signIn.signIn(credentials.id, { method: 'password' });
    const user = await this.users.findById(credentials.id);
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS); // deleted meanwhile
    return user;
  }

  /**
   * Changes the password after checking the current one, ends every other session of the user,
   * and gives this browser's session a new id (privilege change).
   */
  async changePassword(
    user: PublicUser,
    currentSessionId: string,
    { currentPassword, newPassword }: ChangePasswordRequest,
    ip?: string,
  ): Promise<void> {
    this.throttle.assertAllowed(user.username);
    const credentials = await this.users.findCredentials(user.username);
    if (!credentials || !(await this.hasher.verify(currentPassword, credentials.passwordHash))) {
      this.throttle.recordFailure(user.username);
      await this.audit.tryRecord({
        action: 'auth.password_change',
        outcome: 'failure',
        userId: user.id,
        username: user.username,
        ip,
        details: { reason: AUTH_ERROR_CODES.wrongPassword },
      });
      throw new BadRequestException(WRONG_CURRENT_PASSWORD);
    }
    this.throttle.reset(user.username);
    await this.users.updatePasswordHash(user.id, await this.hasher.hash(newPassword));
    await this.sessions.revokeAll(user.id, { except: currentSessionId });
    await this.signIn.rotateSession();
    await this.audit.tryRecord({
      action: 'auth.password_change',
      outcome: 'success',
      userId: user.id,
      username: user.username,
      ip,
    });
  }
}
