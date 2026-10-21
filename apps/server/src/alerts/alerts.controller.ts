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
} from '@laris/shared';
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

/** Per IP, for changes; reads aren't limited. */
const CHANGE_LIMIT = { default: { limit: 20, ttl: 60_000 } };
/** A test sends a real message: few per minute. */
const TEST_LIMIT = { default: { limit: 5, ttl: 60_000 } };

/** Health alerts (docs/plans/health_alerts.md). Every route needs a session. */
@Controller('alerts')
@UseFilters(TooManyAttemptsFilter)
export class AlertsController {
  constructor(
    private readonly records: AlertRecords,
    private readonly channels: AlertChannels,
    private readonly topic: AlertsTopic,
  ) {}

  @Get()
  status(): Promise<AlertsStatus> {
    return this.topic.snapshot();
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
    if (!(await this.records.acknowledge(id, user))) {
      throw new NotFoundException({
        message: 'No such open alert',
        code: ALERT_ERROR_CODES.alertNotFound,
      });
    }
  }

  @Get('channels')
  channelSettings(): Promise<AlertChannelsResponse> {
    return this.channels.view();
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
    return this.channels.updateEmail(body, { user, ip });
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
    return this.channels.updateNtfy(body, { user, ip });
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
    return this.channels.test(channel, { user, ip });
  }
}
