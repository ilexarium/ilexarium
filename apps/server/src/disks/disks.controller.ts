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
import type { DiskMountedResponse, DisksStatus, PublicUser } from '@homelab/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { DiskManager } from './disk-manager.js';
import { DiskMountDto, DiskNameParamsDto } from './disks.dto.js';

/** Per IP, for changes (privileged, rare); reads aren't limited. */
const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };

/** Disks (docs/plans/disk_management.md). Every route needs a session. */
@Controller('disks')
@UseFilters(TooManyAttemptsFilter)
export class DisksController {
  constructor(private readonly disks: DiskManager) {}

  @Get()
  status(): Promise<DisksStatus> {
    return this.disks.status();
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
    return this.disks.mount(body, { user, ip });
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
    return this.disks.unmount(name, { user, ip });
  }
}
