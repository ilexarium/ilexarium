import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  Post,
  Put,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ALERT_ERROR_CODES,
  type AlertChannelsResponse,
  type AlertsStatus,
  type AlertTestResponse,
  type PublicUser,
} from '@ilex/shared';
import { TooManyAttemptsFilter } from '../auth/too-many-attempts.filter.js';
import { AlertChannels } from './alert-channels.js';
import { AlertRecords } from './alert-records.js';
import { AlertsTopic } from './alerts-topic.js';
import {
  AlertChannelParamsDto,
  AlertIdParamsDto,
  EmailChannelUpdateDto,
  NtfyChannelUpdateDto,
} from './alerts.dto.js';
import { CHANGE_LIMIT, TEST_LIMIT } from './alerts.constants.js';

/** Health alerts (docs/plans/health_alerts.md). Every route needs a session. */
@Controller('alerts')
@UseFilters(TooManyAttemptsFilter)
export class AlertsController {
  constructor(
    private readonly alertRecords: AlertRecords,
    private readonly alertChannels: AlertChannels,
    private readonly alertsTopic: AlertsTopic,
  ) {}

  @Get()
  status(): Promise<AlertsStatus> {
    return this.alertsTopic.snapshot();
  }

  /** Stops the reminders of an open alert. */
  @Post(':id/acknowledge')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  async acknowledge(
    @Param() { id }: AlertIdParamsDto,
    @CurrentUser() user: PublicUser,
  ): Promise<void> {
    if (!(await this.alertRecords.acknowledge(id, user))) {
      throw new NotFoundException({
        message: 'No such open alert',
        code: ALERT_ERROR_CODES.alertNotFound,
      });
    }
  }

  @Get('channels')
  channelSettings(): Promise<AlertChannelsResponse> {
    return this.alertChannels.view();
  }

  @Put('channels/email')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  updateEmail(
    @Body() body: EmailChannelUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.alertChannels.updateEmail(body, { user, ip });
  }

  @Put('channels/ntfy')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle(CHANGE_LIMIT)
  updateNtfy(
    @Body() body: NtfyChannelUpdateDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    return this.alertChannels.updateNtfy(body, { user, ip });
  }

  /** Sends a test message through a channel (switched on or not). */
  @Post('channels/:channel/test')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle(TEST_LIMIT)
  test(
    @Param() { channel }: AlertChannelParamsDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<AlertTestResponse> {
    return this.alertChannels.test(channel, { user, ip });
  }
}
