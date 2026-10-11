import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AuthenticationEvents, type AuthenticationEvent } from '@nestjs/authentication';
import type { Subscription } from 'rxjs';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';

/**
 * Records the package's sign-in and sign-out events in the audit log. Failed sign-ins are
 * recorded by our login code (the package never sees them). Best-effort (`tryRecord`): a broken
 * audit table must not lock everyone out.
 */
@Injectable()
export class AuthEventsAuditBridge implements OnModuleInit, OnModuleDestroy {
  private subscription?: Subscription;

  constructor(
    private readonly events: AuthenticationEvents,
    private readonly audit: AuditService,
    private readonly users: UsersService,
  ) {}

  onModuleInit() {
    this.subscription = this.events.events$.subscribe((event) => void this.handle(event));
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  /** Resolves once the event is recorded (or skipped). Exposed for tests. */
  async handle(event: AuthenticationEvent): Promise<void> {
    if (event.type !== 'sign-in' && event.type !== 'sign-out') return;
    const user = await this.users.findById(event.userId).catch(() => null);
    const ip = event.type === 'sign-in' ? event.metadata?.['ip'] : undefined;
    await this.audit.tryRecord({
      action: event.type === 'sign-in' ? 'auth.login' : 'auth.logout',
      outcome: 'success',
      userId: event.userId,
      username: user?.username,
      ip: typeof ip === 'string' ? ip : undefined,
      details:
        event.type === 'sign-in'
          ? { method: event.method ?? 'unknown' }
          : { everywhere: event.everywhere === true },
    });
  }
}
