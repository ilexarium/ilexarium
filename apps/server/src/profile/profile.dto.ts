import { z } from 'zod';
import { profileUpdateSchema } from '@laris/shared';
import { zodDto } from '../common/zod-dto.js';

export class ProfileUpdateDto extends zodDto(profileUpdateSchema) {}

/** `GET /api/profile/avatar?v=…`: the version only says whether the browser may keep it. */
export class AvatarQueryDto extends zodDto(
  z.strictObject({
    v: z
      .string()
      .regex(/^\d{1,16}$/)
      .optional(),
  }),
) {}
