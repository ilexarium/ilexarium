import { Controller, Get, HttpCode, Ip, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser, SystemServiceDetails, SystemServicesResponse } from '@laris/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { ACTION_LIMIT } from './system-services.constants.js';
import { SystemServiceActionParamsDto, SystemServiceParamsDto } from './system-services.dto.js';
import { SystemServicesService } from './system-services.service.js';

/**
 * The host's services, read as the signed-in Linux account (403 `linux_session_required`
 * without one); started, stopped and restarted through its unlocked sudo (403 `sudo_required`).
 */
@Controller('system/services')
@UseFilters(TooManyAttemptsFilter)
export class SystemServicesController {
  constructor(private readonly systemServicesService: SystemServicesService) {}

  @Get()
  list(@CurrentSession() session: { id: string }): Promise<SystemServicesResponse> {
    return this.systemServicesService.list(session.id);
  }

  @Get(':name')
  details(
    @Param() { name }: SystemServiceParamsDto,
    @CurrentSession() session: { id: string },
  ): Promise<SystemServiceDetails> {
    return this.systemServicesService.details(session.id, name);
  }

  /** 204 once systemd's job is done. */
  @Post(':name/:action')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(ACTION_LIMIT)
  act(
    @Param() { name, action }: SystemServiceActionParamsDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.systemServicesService.act(session.id, name, action, { user, ip });
  }
}
