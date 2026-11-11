import { Body, Controller, Get, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { DiskMountedResponse, DisksStatus, PublicUser } from '@ilex/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { DiskManager } from './disk-manager.js';
import { CHANGE_LIMIT } from './disks.constants.js';
import { DiskMountDto, DiskUnmountDto } from './disks.dto.js';

/** Disks. Every route needs a session. */
@Controller('disks')
@UseFilters(TooManyAttemptsFilter)
export class DisksController {
  constructor(private readonly diskManager: DiskManager) {}

  @Get()
  status(): Promise<DisksStatus> {
    return this.diskManager.status();
  }

  /** Mounts a disk at a folder (`/mnt/<name>` by default), kept after a restart — through the person's sudo. */
  @Post('mount')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  mount(
    @Body() body: DiskMountDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<DiskMountedResponse> {
    return this.diskManager.mount(body, { user, ip, appSessionId: session.id });
  }

  /** Unmounts a disk mounted here (or forgets one no longer connected). */
  @Post('unmount')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  unmount(
    @Body() { mountPoint }: DiskUnmountDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.diskManager.unmount(mountPoint, { user, ip, appSessionId: session.id });
  }
}
