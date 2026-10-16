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
} from '@homelab/shared';
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

/** The same for confirming the password before something sensitive ("Show again"). */
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

  /**
   * First-run setup: with the one-time setup token, creates the owner account and signs this
   * browser in. Only while no user exists; concurrent attempts can't both succeed.
   */
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

  /**
   * The signed-in user's password, asked again before something sensitive (showing the backup
   * passphrase). Throttled like sign-in; a wrong one is a 400 on the field (never a 401).
   */
  async confirmPassword(user: PublicUser, password: string, ip?: string): Promise<void> {
    this.throttle.assertAllowed(user.username);
    const credentials = await this.users.findCredentials(user.username);
    if (!credentials || !(await this.hasher.verify(password, credentials.passwordHash))) {
      this.throttle.recordFailure(user.username);
      await this.audit.tryRecord({
        action: 'auth.password_confirm',
        outcome: 'failure',
        userId: user.id,
        username: user.username,
        ip,
        details: { reason: AUTH_ERROR_CODES.wrongPassword },
      });
      throw new BadRequestException(WRONG_PASSWORD);
    }
    this.throttle.reset(user.username);
  }
}
