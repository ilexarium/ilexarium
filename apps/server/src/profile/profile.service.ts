import { BadRequestException, Injectable, PayloadTooLargeException } from '@nestjs/common';
import {
  PROFILE_ERROR_CODES,
  PROFILE_LIMITS,
  type ProfileUpdate,
  type PublicUser,
} from '@ilex/shared';
import { AuditService } from '../audit/audit.service.js';
import type { ProfileFields, StoredAvatar } from '../users/users.model.js';
import { UsersService } from '../users/users.service.js';
import { inspectPicture } from './profile-picture.js';
import type { ProfileActor } from './profile.model.js';

/**
 * The signed-in person's profile (docs/plans/profile.md): name, address, language and picture.
 * Reading is `GET /api/auth/me`; this only changes. Audited by field name — never the values (an
 * address is personal data, a picture is a picture).
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  /** An empty name or address removes it. */
  async update(update: ProfileUpdate, { user, ip }: ProfileActor): Promise<PublicUser> {
    const fields: ProfileFields = {};
    if (update.displayName !== undefined) fields.displayName = update.displayName || null;
    if (update.email !== undefined) fields.email = update.email || null;
    if (update.language !== undefined) fields.language = update.language;
    const updated = await this.usersService.updateProfile(user.id, fields);
    await this.auditService.tryRecord({
      action: 'profile.update',
      outcome: 'success',
      userId: user.id,
      username: user.username,
      ip,
      details: { fields: Object.keys(fields) },
    });
    return updated;
  }

  /**
   * Keeps a picture only if its bytes are a WebP, JPEG or PNG of exactly `pictureSize` square,
   * at most `pictureMaxBytes` — whatever the browser said it was.
   */
  async setAvatar(bytes: Buffer, { user, ip }: ProfileActor): Promise<PublicUser> {
    if (bytes.length > PROFILE_LIMITS.pictureMaxBytes) throw pictureTooLarge();
    const picture = inspectPicture(bytes);
    const size = PROFILE_LIMITS.pictureSize;
    if (!picture || picture.width !== size || picture.height !== size) throw invalidPicture();
    const updated = await this.usersService.setAvatar(user.id, bytes, picture.type);
    await this.auditService.tryRecord({
      action: 'profile.avatar',
      outcome: 'success',
      userId: user.id,
      username: user.username,
      ip,
      details: { change: 'set', type: picture.type, bytes: bytes.length },
    });
    return updated;
  }

  async removeAvatar({ user, ip }: ProfileActor): Promise<PublicUser> {
    const updated = await this.usersService.removeAvatar(user.id);
    await this.auditService.tryRecord({
      action: 'profile.avatar',
      outcome: 'success',
      userId: user.id,
      username: user.username,
      ip,
      details: { change: 'removed' },
    });
    return updated;
  }

  avatar(userId: string): Promise<StoredAvatar | null> {
    return this.usersService.findAvatar(userId);
  }
}

export function invalidPicture(): BadRequestException {
  const size = PROFILE_LIMITS.pictureSize;
  return new BadRequestException({
    message: `A WebP, JPEG or PNG picture of ${size}×${size} pixels`,
    code: PROFILE_ERROR_CODES.invalidPicture,
  });
}

export function pictureTooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException({
    message: `At most ${PROFILE_LIMITS.pictureMaxBytes} bytes`,
    code: PROFILE_ERROR_CODES.pictureTooLarge,
  });
}
