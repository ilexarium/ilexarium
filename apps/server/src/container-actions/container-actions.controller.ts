import { Controller, HttpCode, Ip, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser } from '@ilex/shared';
import { ContainerActionParamsDto } from './container-actions.dto.js';
import { ACTION_LIMIT } from './container-actions.constants.js';
import { ContainerActionsService } from './container-actions.service.js';

@Controller('containers')
@UseGuards(ThrottlerGuard)
export class ContainerActionsController {
  constructor(private readonly containerActionsService: ContainerActionsService) {}

  /** 204 once Docker is done; the page sees the new state through the `containers` topic. */
  @Post(':name/:action')
  @HttpCode(204)
  @Throttle(ACTION_LIMIT)
  async act(
    @Param() { name, action }: ContainerActionParamsDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    await this.containerActionsService.act(action, name, { user, ip });
  }
}
