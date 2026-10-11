import { Module } from '@nestjs/common';
import { AuthenticationModule, type SessionOptions } from '@nestjs/authentication';
import { AuditModule } from '../audit/audit.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthEventsAuditBridge } from './auth-events-audit.bridge.js';
import { PrismaSessionStore } from './prisma-session.store.js';
import { SessionAuth } from './session-auth.provider.js';

const USER_AGENT_MAX_LENGTH = 256;

/** Stored with each new session, for a later "where you're signed in" page (and the audit IP). */
const sessionMetadata: SessionOptions['metadata'] = (request) => ({
  ip: request.ip,
  userAgent: String(request.headers['user-agent'] ?? '').slice(0, USER_AGENT_MAX_LENGTH),
});

/**
 * Wires @nestjs/authentication (see docs/plans/auth.md): cookie sessions only (`__Host-sid`,
 * HttpOnly, Secure, SameSite=Lax), package-default lifetimes, no access/refresh tokens.
 * Registers the global default-deny guard: every route needs a signed-in user unless @Public().
 */
@Module({
  imports: [
    AuthenticationModule.forRoot({
      session: { absoluteTtl: '7d', idleTtl: '1d', metadata: sessionMetadata },
    }),
    UsersModule,
    AuditModule,
  ],
  providers: [PrismaSessionStore, SessionAuth, AuthEventsAuditBridge],
})
export class AuthModule {}
