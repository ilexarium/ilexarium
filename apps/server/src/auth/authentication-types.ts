import type { PublicUser } from '@homelab/shared';
import type { SessionRecord } from '@nestjs/authentication';

// Types @CurrentUser(), @CurrentSession() and SessionRecord.extra for the whole app.
// The user is always the public shape: the password hash can't reach a controller.
declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: PublicUser;
    session: SessionRecord;
    sessionExtra: { user: PublicUser };
  }
}
