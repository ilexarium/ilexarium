import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { DiskMountedResponse, DisksStatus, PublicUser } from '@laris/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { DiskManager } from './disk-manager.js';
import { CHANGE_LIMIT } from './disks.constants.js';
import { DiskMountDto, DiskNameParamsDto } from './disks.dto.js';

/** Disks (docs/plans/disk_management.md). Every route needs a session. */
@Controller('disks')
@UseFilters(TooManyAttemptsFilter)
export class DisksController {
  constructor(private readonly diskManager: DiskManager) {}

  @Get()
  status(): Promise<DisksStatus> {
    return this.diskManager.status();
  }

  /** Mounts a disk at /mnt/<name>, kept after a restart. */
  @Post('mount')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  mount(
    @Body() body: DiskMountDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<DiskMountedResponse> {
    return this.diskManager.mount(body, { user, ip });
  }

  /** Unmounts a disk mounted here (or forgets one no longer connected). */
  @Delete(':name')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  unmount(
    @Param() { name }: DiskNameParamsDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.diskManager.unmount(name, { user, ip });
  }
}
