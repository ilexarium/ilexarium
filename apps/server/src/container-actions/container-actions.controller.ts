import { Controller, HttpCode, Ip, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { PublicUser } from '@laris/shared';
import { ContainerActionParamsDto } from './container-actions.dto.js';
import { ContainerActionsService } from './container-actions.service.js';

/** Per IP: plenty for clicking through the menu, not for a script stopping everything in a loop. */
const ACTION_LIMIT = { default: { limit: 20, ttl: 60_000 } };

@Controller('containers')
@UseGuards(ThrottlerGuard)
export class ContainerActionsController {
  constructor(private readonly actions: ContainerActionsService) {}

  /**
   * Start, stop or restart a container; 204 once Docker is done ("already running/stopped"
   * counts). The page sees the new state through the `containers` topic, not this answer.
   */
  @Post(':name/:action')
  @HttpCode(204)
  @Throttle(ACTION_LIMIT)
  async act(
    @Param() { name, action }: ContainerActionParamsDto,
    @CurrentUser() user: PublicUser,
    @Ip() ip: string,
  ): Promise<void> {
    await this.actions.act(action, name, { user, ip });
  }
}
