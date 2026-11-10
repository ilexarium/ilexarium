import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  SessionCookieProvider,
  type SessionRecord,
} from '@nestjs/authentication';
import type { PublicUser } from '@ilex/shared';
import { UsersService } from '../users/users.service.js';
import './authentication-types.js';

/** Always the public shape, so `@CurrentUser()` can't carry the hash. `null` ends the session. */
@Injectable()
export class SessionAuth extends SessionCookieProvider<PublicUser> {
  constructor(
    private readonly users: UsersService,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this);
  }

  protected validate(session: SessionRecord): PublicUser | null | Promise<PublicUser | null> {
    return session.extra?.user ?? this.users.findById(session.userId);
  }
}
