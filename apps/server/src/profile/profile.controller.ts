import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  NotFoundException,
  Patch,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PROFILE_LIMITS, type PublicUser, type UserResponse } from '@ilex/shared';
import type { Request, Response } from 'express';
import { CHANGE_LIMIT } from './profile.constants.js';
import { AvatarQueryDto, ProfileUpdateDto } from './profile.dto.js';
import { invalidPicture, pictureTooLarge, ProfileService } from './profile.service.js';
import { readBody } from './read-body.js';

/** Changes to the signed-in person's profile; reading it is `GET /api/auth/me`. */
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Patch()
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  async update(
    @Body() body: ProfileUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<UserResponse> {
    return { user: await this.profileService.update(body, { user, ip }) };
  }

  /** The body is the picture itself, judged by its bytes (`Content-Type` is ignored). */
  @Put('avatar')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  async setAvatar(
    @Req() req: Request,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<UserResponse> {
    const bytes = await readBody(req, PROFILE_LIMITS.pictureMaxBytes, {
      tooLarge: pictureTooLarge,
      unreadable: invalidPicture,
    });
    return { user: await this.profileService.setAvatar(bytes, { user, ip }) };
  }

  @Delete('avatar')
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  async removeAvatar(@CurrentUser() user: PublicUser, @Ip() ip: string): Promise<UserResponse> {
    return { user: await this.profileService.removeAvatar({ user, ip }) };
  }

  /**
   * The picture, only ever as an image: its checked type, never sniffed, sandboxed if opened.
   * Kept by the browser for as long as the address names the current version.
   */
  @Get('avatar')
  async avatar(
    @Query() { v }: AvatarQueryDto,
    @CurrentUser() user: PublicUser,
    @Res() res: Response,
  ): Promise<void> {
    const avatar = await this.profileService.avatar(user.id);
    if (!avatar) throw new NotFoundException('No picture');
    const current = v === String(avatar.updatedAt.getTime());
    res.status(200).set({
      'Content-Type': avatar.type,
      'Content-Length': String(avatar.bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': current ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    });
    res.end(Buffer.from(avatar.bytes));
  }
}
