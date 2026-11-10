import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PasswordHasher, SessionService, SignInService } from '@nestjs/authentication';
import {
  AUTH_ERROR_CODES,
  type ApiErrorResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type PublicUser,
  type SetupRequest,
} from '@ilex/shared';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { SetupService } from './setup.service.js';

/** Same response for an unknown username and a wrong password: no account enumeration. */
const INVALID_CREDENTIALS: ApiErrorResponse = {
  message: 'Invalid username or password',
  code: AUTH_ERROR_CODES.invalidCredentials,
};

const SETUP_NOT_AVAILABLE: ApiErrorResponse = {
  message: 'Setup has already been completed',
  code: AUTH_ERROR_CODES.setupNotAvailable,
};

const INVALID_SETUP_TOKEN: ApiErrorResponse = {
  message: 'This setup code is not valid',
  code: AUTH_ERROR_CODES.invalidSetupToken,
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

const WRONG_PASSWORD: ApiErrorResponse = {
  message: 'Validation failed',
  errors: [
    { field: 'password', code: AUTH_ERROR_CODES.wrongPassword, message: 'Password is incorrect' },
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
    private readonly setupToken: SetupService,
  ) {}

  /** Only while no user exists; `createFirstUser` makes sure two at once can't both win. */
  async setup({ setupToken, username, password }: SetupRequest, ip?: string): Promise<PublicUser> {
    if (!this.setupToken.isPending()) throw new ForbiddenException(SETUP_NOT_AVAILABLE);
    if (!this.setupToken.verify(setupToken)) {
      await this.audit.tryRecord({
        action: 'auth.setup',
        outcome: 'failure',
        username,
        ip,
        details: { reason: AUTH_ERROR_CODES.invalidSetupToken },
      });
      throw new ForbiddenException(INVALID_SETUP_TOKEN);
    }
    const passwordHash = await this.hasher.hash(password);
    const user = await this.users.createFirstUser({ username, passwordHash });
    if (!user) throw new ForbiddenException(SETUP_NOT_AVAILABLE); // lost a race
    await this.setupToken.complete();
    await this.audit.tryRecord({
      action: 'auth.setup',
      outcome: 'success',
      userId: user.id,
      username: user.username,
      ip,
    });
    await this.signIn.signIn(user.id, { method: 'setup' });
    return user;
  }

  /** Success is audited through the package's sign-in event (`AuthEventsAuditBridge`). */
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

  /** Ends every other session of the user, and gives this one a new id (privilege change). */
  async changePassword(
    user: PublicUser,
    currentSessionId: string,
    { currentPassword, newPassword }: ChangePasswordRequest,
    ip?: string,
  ): Promise<void> {
    await this.checkPassword(
      user,
      currentPassword,
      'auth.password_change',
      WRONG_CURRENT_PASSWORD,
      ip,
    );
    await this.users.updatePasswordHash(user.id, await this.hasher.hash(newPassword));
    // One by one: `revoke` announces each sign-out, so their sockets, log streams and Linux
    // sessions end too (`revokeAll` only deletes rows); then whatever was already dead.
    for (const session of await this.sessions.list(user.id)) {
      if (session.id !== currentSessionId)
        await this.sessions.revoke(session.id, { userId: user.id });
    }
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

  /** Asked again before something sensitive (showing the backup passphrase). */
  async confirmPassword(user: PublicUser, password: string, ip?: string): Promise<void> {
    await this.checkPassword(user, password, 'auth.password_confirm', WRONG_PASSWORD, ip);
  }

  /** Throttled like sign-in. Wrong: a 400 on the field, as a 401 would sign the browser out. */
  private async checkPassword(
    user: PublicUser,
    password: string,
    action: 'auth.password_change' | 'auth.password_confirm',
    wrong: ApiErrorResponse,
    ip?: string,
  ): Promise<void> {
    this.throttle.assertAllowed(user.username);
    const credentials = await this.users.findCredentials(user.username);
    if (!credentials || !(await this.hasher.verify(password, credentials.passwordHash))) {
      this.throttle.recordFailure(user.username);
      await this.audit.tryRecord({
        action,
        outcome: 'failure',
        userId: user.id,
        username: user.username,
        ip,
        details: { reason: AUTH_ERROR_CODES.wrongPassword },
      });
      throw new BadRequestException(wrong);
    }
    this.throttle.reset(user.username);
  }
}
