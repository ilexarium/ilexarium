import { Module } from '@nestjs/common';
import { AuthenticationModule, type SessionOptions } from '@nestjs/authentication';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from '../audit/audit.module.js';
import { clientKey } from '../common/client-key.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthEventsAuditBridge } from './auth-events-audit.bridge.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordHashSlots } from './password-hash-slots.js';
import { PrismaSessionStore } from './prisma-session.store.js';
import { SessionAuth } from './session-auth.provider.js';
import { SetupService } from './setup.service.js';

const USER_AGENT_MAX_LENGTH = 256;

/** For a later "where you're signed in" page, and the audit log's IP. */
const sessionMetadata: SessionOptions['metadata'] = (request) => ({
  ip: request.ip,
  userAgent: String(request.headers['user-agent'] ?? '').slice(0, USER_AGENT_MAX_LENGTH),
});

/** Its guard is global: every route needs a session unless @Public(). */
@Module({
  imports: [
    AuthenticationModule.forRoot({
      session: { absoluteTtl: '7d', idleTtl: '1d', metadata: sessionMetadata },
    }),
    // Per-IP limit for /api/auth/*; password routes tighten it with @Throttle.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 30 }],
      // An IPv6 client has a whole /64 to pick addresses from.
      getTracker: (request: Record<string, unknown>) => clientKey(request['ip'] as string),
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
    LoginThrottleService,
    PasswordHashSlots,
  ],
  // Other features ask for the password again (confirmPassword).
  exports: [AuthService],
})
export class AuthModule {}
