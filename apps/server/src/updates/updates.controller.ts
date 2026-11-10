import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Put,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser, StartUpdateResponse, UpdatesStatus } from '@ilex/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { UPDATE_CHANGE_LIMIT } from './updates.constants.js';
import { StartUpdateDto, UpdateSettingsDto } from './updates.dto.js';
import { UpdatesService } from './updates.service.js';

/** Ilexarium's own updates (docs/plans/install_and_update.md). Every route needs a session. */
@Controller('updates')
@UseFilters(TooManyAttemptsFilter)
export class UpdatesController {
  constructor(private readonly updatesService: UpdatesService) {}

  @Get()
  status(): Promise<UpdatesStatus> {
    return this.updatesService.status();
  }

  @Post('check')
  @UseGuards(ThrottlerGuard)
  @Throttle(UPDATE_CHANGE_LIMIT)
  async check(): Promise<UpdatesStatus> {
    await this.updatesService.check();
    return this.updatesService.status();
  }

  @Put('settings')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(UPDATE_CHANGE_LIMIT)
  settings(@Body() { checkAutomatically }: UpdateSettingsDto): Promise<void> {
    return this.updatesService.setCheckAutomatically(checkAutomatically);
  }

  /** Starts the update through the person's sudo; it runs on as its own unit while Ilexarium restarts. */
  @Post()
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @Throttle(UPDATE_CHANGE_LIMIT)
  start(
    @Body() { version }: StartUpdateDto,
    @CurrentSession() session: { id: string },
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<StartUpdateResponse> {
    return this.updatesService.start(version, { user, ip, appSessionId: session.id });
  }
}
