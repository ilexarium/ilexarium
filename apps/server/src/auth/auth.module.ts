import { Module } from '@nestjs/common';
import { AuthenticationModule, type SessionOptions } from '@nestjs/authentication';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from '../audit/audit.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthEventsAuditBridge } from './auth-events-audit.bridge.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PrismaSessionStore } from './prisma-session.store.js';
import { SessionAuth } from './session-auth.provider.js';
import { SetupService } from './setup.service.js';

const USER_AGENT_MAX_LENGTH = 256;

/** Stored with each new session, for a later "where you're signed in" page (and the audit IP). */
const sessionMetadata: SessionOptions['metadata'] = (request) => ({
  ip: request.ip,
  userAgent: String(request.headers['user-agent'] ?? '').slice(0, USER_AGENT_MAX_LENGTH),
});

/**
 * Wires @nestjs/authentication (see docs/plans/auth.md): cookie sessions only (`__Host-sid`,
 * HttpOnly, Secure, SameSite=Lax), package-default lifetimes, no access/refresh tokens,
 * scrypt passwords with the package's defaults. Registers the global default-deny guard:
 * every route needs a signed-in user unless @Public().
 */
@Module({
  imports: [
    AuthenticationModule.forRoot({
      session: { absoluteTtl: '7d', idleTtl: '1d', metadata: sessionMetadata },
    }),
    // Per-IP limit for /api/auth/*; password routes tighten it with @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 30 }],
      errorMessage: 'Too many requests. Try again later.',
    }),
    UsersModule,
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [
    PrismaSessionStore,
    SessionAuth,
    AuthEventsAuditBridge,
    AuthService,
    SetupService,
    // Factory: its optional clock argument is for tests, not for injection.
    { provide: LoginThrottleService, useFactory: () => new LoginThrottleService() },
  ],
  // Other features ask for the password again before something sensitive (the backup passphrase).
  exports: [AuthService],
})
export class AuthModule {}
